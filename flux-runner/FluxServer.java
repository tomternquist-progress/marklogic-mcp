import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Minimal HTTP sidecar that runs MarkLogic Flux CLI commands on behalf of the MCP server.
 *
 * POST /run   { "args": ["import-delimited-files", "--path", "/data/file.csv", ...] }
 *             → { "exitCode": 0, "output": "..." }
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

            // Build full command: /flux/bin/flux <user args...>
            List<String> cmd = new ArrayList<>();
            cmd.add("/flux/bin/flux");
            cmd.addAll(userArgs);

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
