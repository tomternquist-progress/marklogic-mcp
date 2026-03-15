import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Minimal HTTP sidecar that runs MarkLogic Flux CLI commands on behalf of the MCP server.
 *
 * POST /run   { "args": ["import-delimited-files", "--path", "/data/file.csv", ...] }
 *             → { "exitCode": 0, "output": "..." }
 *
 * Supports --http-url <url> in place of --path: the file is downloaded to /tmp/
 * before Flux runs, then cleaned up afterwards.
 *
 * GET  /health → { "status": "ok" }
 *
 * The flux binary is expected at /flux/bin/flux.
 * All connection args (--connection-string etc.) must be supplied by the caller.
 */
public class FluxServer {

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("FLUX_PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/run", new RunHandler());
        server.createContext("/health", exchange -> {
            respond(exchange, 200, "{\"status\":\"ok\"}");
        });

        // Thread pool: Flux jobs are blocking so keep pool small to avoid resource exhaustion
        server.setExecutor(Executors.newFixedThreadPool(4));
        System.out.println("Flux runner listening on :" + port);
        server.start();
    }

    static class RunHandler implements HttpHandler {
        private static final int TIMEOUT_MINUTES = Integer.parseInt(
            System.getenv().getOrDefault("FLUX_TIMEOUT_MINUTES", "30")
        );

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }

            String body;
            try (InputStream is = exchange.getRequestBody()) {
                body = new String(is.readAllBytes(), StandardCharsets.UTF_8);
            }

            List<String> userArgs;
            try {
                userArgs = parseArgsFromJson(body);
            } catch (Exception e) {
                respond(exchange, 400, jsonObj("error", "Invalid request body: " + e.getMessage()));
                return;
            }

            if (userArgs.isEmpty()) {
                respond(exchange, 400, jsonObj("error", "args array is empty"));
                return;
            }

            // Resolve any --http-url flags by downloading to /tmp first
            List<Path> tempFiles = new ArrayList<>();
            List<String> resolvedArgs;
            try {
                resolvedArgs = resolveHttpUrls(userArgs, tempFiles);
            } catch (Exception e) {
                respond(exchange, 400, jsonObj("error", "Failed to download --http-url: " + e.getMessage()));
                return;
            }

            // Build full command: /flux/bin/flux <user args...>
            List<String> cmd = new ArrayList<>();
            cmd.add("/flux/bin/flux");
            cmd.addAll(resolvedArgs);

            try {
                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.redirectErrorStream(true); // merge stderr into stdout
                pb.environment().put("HOME", "/tmp");

                Process process = pb.start();
                boolean finished = process.waitFor(TIMEOUT_MINUTES, TimeUnit.MINUTES);

                String output;
                try (InputStream is = process.getInputStream()) {
                    output = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                }

                if (!finished) {
                    process.destroyForcibly();
                    respond(exchange, 200, String.format(
                        "{\"exitCode\":-1,\"output\":%s,\"timedOut\":true}",
                        jsonString("Flux process timed out after " + TIMEOUT_MINUTES + " minutes. " + output)
                    ));
                    return;
                }

                int exitCode = process.exitValue();
                String json = String.format("{\"exitCode\":%d,\"output\":%s}", exitCode, jsonString(output));
                respond(exchange, 200, json);

            } catch (Exception e) {
                respond(exchange, 500, String.format(
                    "{\"exitCode\":-1,\"output\":%s}", jsonString("Failed to start flux: " + e.getMessage())
                ));
            } finally {
                // Clean up any temp files/dirs downloaded for this run
                for (Path p : tempFiles) {
                    try {
                        if (Files.isDirectory(p)) {
                            Files.walk(p)
                                .sorted(Comparator.reverseOrder())
                                .forEach(f -> { try { Files.deleteIfExists(f); } catch (Exception ignored) {} });
                        } else {
                            Files.deleteIfExists(p);
                        }
                    } catch (Exception ignored) {}
                }
            }
        }

        /**
         * Scan args for --http-url <url>. For each occurrence, download the file
         * to /tmp/<filename> (following redirects), record it in tempFiles for cleanup,
         * and replace --http-url <url> with --path <local-path> in the returned list.
         */
        private List<String> resolveHttpUrls(List<String> args, List<Path> tempFiles) throws Exception {
            List<String> result = new ArrayList<>(args);
            HttpClient httpClient = null; // lazy-init only if needed

            for (int i = 0; i < result.size() - 1; i++) {
                if ("--http-url".equals(result.get(i))) {
                    String url = result.get(i + 1);

                    // Derive a safe filename from the URL path
                    String urlPath = new URI(url).getPath();
                    String filename = Paths.get(urlPath).getFileName().toString();
                    if (filename == null || filename.isBlank()) {
                        filename = "flux-download-" + System.currentTimeMillis();
                    }
                    // Strip query/fragment chars that can appear in decoded paths
                    filename = filename.replaceAll("[^a-zA-Z0-9._-]", "_");

                    Path tmpFile = Path.of("/tmp", filename);

                    if (httpClient == null) {
                        httpClient = HttpClient.newBuilder()
                            .followRedirects(HttpClient.Redirect.ALWAYS)
                            .build();
                    }

                    System.out.println("Downloading " + url + " → " + tmpFile);
                    HttpRequest req = HttpRequest.newBuilder(new URI(url)).GET().build();
                    HttpResponse<Path> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofFile(tmpFile));

                    if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                        throw new IOException("HTTP " + resp.statusCode() + " fetching " + url);
                    }

                    System.out.println("Downloaded " + Files.size(tmpFile) + " bytes → " + tmpFile);

                    // ZIP files: extract to a temp directory and pass the dir as --path
                    if (filename.toLowerCase().endsWith(".zip")) {
                        Path extractDir = Path.of("/tmp", "flux-unzip-" + System.currentTimeMillis());
                        Files.createDirectories(extractDir);
                        extractZip(tmpFile, extractDir);
                        Files.deleteIfExists(tmpFile);
                        tempFiles.add(extractDir);
                        result.set(i, "--path");
                        result.set(i + 1, extractDir.toString());
                        System.out.println("Extracted ZIP → " + extractDir);
                    } else {
                        tempFiles.add(tmpFile);
                        result.set(i, "--path");
                        result.set(i + 1, tmpFile.toString());
                    }
                }
            }
            return result;
        }

        /**
         * Extract all files from a ZIP archive into destDir (flat — no subdirectories).
         */
        private void extractZip(Path zipFile, Path destDir) throws IOException {
            try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(zipFile))) {
                ZipEntry entry;
                while ((entry = zis.getNextEntry()) != null) {
                    if (entry.isDirectory()) {
                        zis.closeEntry();
                        continue;
                    }
                    // Use only the filename, stripping any directory prefix inside the ZIP
                    String entryName = Paths.get(entry.getName()).getFileName().toString();
                    entryName = entryName.replaceAll("[^a-zA-Z0-9._-]", "_");
                    Path dest = destDir.resolve(entryName);
                    Files.copy(zis, dest);
                    System.out.println("Extracted " + entry.getName() + " → " + dest);
                    zis.closeEntry();
                }
            }
        }

        /**
         * Parse the "args" string array from a simple JSON object.
         * Handles escaped characters. Does not require a JSON library.
         */
        private List<String> parseArgsFromJson(String json) {
            int start = json.indexOf('[');
            int end = json.lastIndexOf(']');
            if (start < 0 || end < 0 || end <= start) {
                throw new IllegalArgumentException("No args array found in JSON body");
            }

            List<String> result = new ArrayList<>();
            String arr = json.substring(start + 1, end);
            int i = 0;

            while (i < arr.length()) {
                char c = arr.charAt(i);
                if (c == '"') {
                    // Parse quoted string
                    StringBuilder sb = new StringBuilder();
                    i++;
                    while (i < arr.length()) {
                        char ch = arr.charAt(i);
                        if (ch == '\\' && i + 1 < arr.length()) {
                            char next = arr.charAt(i + 1);
                            switch (next) {
                                case '"' -> sb.append('"');
                                case '\\' -> sb.append('\\');
                                case 'n' -> sb.append('\n');
                                case 'r' -> sb.append('\r');
                                case 't' -> sb.append('\t');
                                default -> sb.append(next);
                            }
                            i += 2;
                        } else if (ch == '"') {
                            i++;
                            break;
                        } else {
                            sb.append(ch);
                            i++;
                        }
                    }
                    result.add(sb.toString());
                } else {
                    i++;
                }
            }
            return result;
        }
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static String jsonString(String s) {
        if (s == null) return "null";
        return "\"" + s
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
            + "\"";
    }

    private static String jsonObj(String key, String value) {
        return "{" + jsonString(key) + ":" + jsonString(value) + "}";
    }
}
