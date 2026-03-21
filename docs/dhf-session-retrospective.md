# DHF Session Retrospective — MCP Server Improvements

Learnings from an end-to-end Data Hub Framework (DHF 5.8.1) deployment on MarkLogic 12 running in Kubernetes. Documents gaps in the MCP server and operational patterns that should inform future tool development.

---

## MCP Tool Gaps Found

### 1. Missing: `ml_logs_read` — Read `/manage/v2/logs`  ⭐ HIGH PRIORITY

Every debugging step required dropping out to raw `curl`. A dedicated log-reading tool would keep the full diagnostic trace in one place.

**Reference:** `GET /manage/v2/logs?filename=ErrorLog.txt`

**Proposed parameters:**
```
filename  string    — e.g. "ErrorLog.txt", "8020_AccessLog.txt", "8002_RequestLog.txt"
host      string?   — filter by host (defaults to primary host)
start     datetime? — start time filter
end       datetime? — end time filter
regex     string?   — filter lines matching pattern
tail      integer?  — return last N lines (default 100)
```

**Key log files encountered in this session:**
- `ErrorLog.txt` — main server errors
- `8002_AccessLog.txt` — Management API access
- `8020_AccessLog.txt` — DHF Staging access
- `8021_AccessLog.txt` — DHF Final access

---

### 2. Enhancement: `ml_cluster_status` Should Surface Host Up/Down State

The existing `ml_cluster_status` tool exists but during this session we couldn't easily determine which cluster hosts were online vs offline, or what state their forests were in.

**What would help:**
- Surface `host-status` per host: online / offline / unknown
- Link each offline host to its affected forests and databases

---

### 3. Enhancement: `ml_forests_list` Should Include Host and State

`ml_forests_list` returns names only. During debugging we had to call individual forest property endpoints to find host assignments.

**Proposed additions:**
- `include_host: boolean` — add host name to each forest entry
- `include_state: boolean` — add forest state (open, unmounted, sync-replicating)
- `include_database: boolean` — show which database each forest is attached to (or "detached")

---

### 4. Missing: `ml_database_set_forests`  (or PUT support on `ml_database_properties`)

The critical fix for a forest-hang is setting the forest list directly on a database. This is a `PUT /manage/v2/databases/{name}/properties` with `{"forest": ["forest-name"]}`.

**Current gap:** `ml_database_properties` is read-only. A write path would let the MCP server resolve forest hangs without dropping to curl.

---

## Operational Patterns Learned

### Forest Hang Pattern — Root Cause and Fix

**Symptom:** `curl` connects to a MarkLogic port (TCP handshake succeeds) but the HTTP response never arrives. Looks like a network or firewall issue but is actually inside MarkLogic.

**Root cause:** A MarkLogic database is configured with forests spread across multiple cluster hosts. If any host with an attached forest is offline, the database hangs trying to coordinate with it. Since the modules database is hung, every app server that references it (including the one you're connecting to) also hangs — even if that server's data is on a running host.

**Fix:**
```bash
# For each affected database, restrict it to only forests on available hosts:
curl -u admin:admin -X PUT \
  "http://host:8002/manage/v2/databases/{db}/properties" \
  -H "Content-Type: application/json" \
  -d '{"forest": ["db-name-1"]}'
```
Apply to all databases (STAGING, FINAL, JOBS, MODULES, and the four schema/trigger DBs).

**DHF-specific context:** DHF creates one forest per cluster host per database. In a 3-host cluster with only 1 host running, every DHF database will hang until reduced to its single available-host forest.

---

### Forest Best Practices

- **2 forests per host** is the recommended starting point (not 2 per database)
- **Max ~512 GB per forest** — controls merge time and memory pressure
- **CPU/memory headroom** — each additional forest consumes merge threads, in-memory stand space, and I/O bandwidth; validate resources before adding forests
- **Single-host dev setup:** 2 forests per database, both on the same host — allows MarkLogic to merge one while the other serves queries
- **Scale-out:** In an N-host cluster, target 2 forests × N hosts per database

Reference: https://developer.marklogic.com/learn/data-management/

---

### DHF Auth — Basic Works, No Digest Required

DHF's Gradle/Java client (OkHttp) works fine with Basic auth. There is no requirement to use Digest for DHF servers. The key property in `gradle.properties`:

```properties
mlAuthentication=basic
```

This single property (new in ml-gradle 4.5.0) sets all four auth sub-properties at once:
`mlManageAuthentication`, `mlAdminAuthentication`, `mlAppServicesAuthentication`, `mlRestAuthentication`.

---

### DHF + Java 21: `hubInstallModules` over `mlDeployApp`

`mlDeployApp` (and `hubDeploy`) fail under Java 21 with:
```
java.lang.IllegalAccessError: class LoadUserModulesCommand tried to access
private method 'void java.net.URLDecoder.<init>()'
```
This is a bytecode-level access violation (not reflective), so `--add-opens` does not fix it.

**Workaround:** Use individual tasks that avoid the problematic code path:
```bash
./gradlew hubInstallModules        # loads DHF internal modules
./gradlew hubDeployAsSecurityAdmin # security roles, privileges, amps
./gradlew mlDeployDatabases
./gradlew mlDeployTriggers         # required before first mapping run
./gradlew hubDeployArtifacts hubDeployUserArtifacts
```

---

### DHF Mapping XSLT — Trigger Must Fire

The mapping step requires a compiled XSLT file in data-hub-MODULES. This is generated by a MarkLogic trigger, not by Gradle. If the trigger hasn't fired (e.g. fresh install), the step fails with `XDMP-MODNOTFOUND: /steps/mapping/{name}.step.xml.xslt`.

**Fix sequence:**
1. `./gradlew mlDeployTriggers` — installs the trigger definitions
2. Touch the mapping step document to fire the trigger:
   ```javascript
   // Run in data-hub-STAGING via eval
   var uri = "/steps/mapping/MapCustomers.step.json";
   declareUpdate();
   xdmp.nodeReplace(cts.doc(uri), cts.doc(uri));
   ```

---

### Kubernetes: DHF Ports and the MarkLogic Operator

The MarkLogic K8s Operator reconciles the `apps-cluster` LoadBalancer service. Manual `kubectl patch` additions (e.g. ports 8020/8021/8022) are overwritten on pod restart.

**Durable fix:** Create a separate service outside operator control, or use `kubectl port-forward` for development:
```bash
kubectl port-forward -n marklogic pod/apps-0 \
  8000:8000 8001:8001 8002:8002 8020:8020 8021:8021 8022:8022
```

---

### DHF JOBS Server Default Port Collision

`hubInit` scaffolds the JOBS app server on port 8010 by default, which conflicts with other MarkLogic internal servers. Always override in `gradle.properties`:

```properties
mlStagingPort=8020
mlFinalPort=8021
mlJobsPort=8022
```
