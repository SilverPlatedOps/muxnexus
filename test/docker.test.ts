import { describe, expect, test } from "bun:test";
import type { DockerContainer, DockerStats, ServerMessage } from "../src/shared/protocol";
import { createServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import { waitFor } from "./helpers";
import { containerLabel, engineNote, groupContainers } from "../src/client/docker";
import { createDockerReader, EngineUnavailable, parsePs, parseSize, parseStats, run } from "../src/server/docker";

const PS = [
  "aaa\tshop-orders-kafka-1\tconfluentinc/cp-kafka:8.1.1\trunning\tUp 34 hours\tshop-orders\tkafka",
  "bbb\tshop-orders-postgresql-1\tpostgres:13-alpine\trunning\tUp 34 hours\tshop-orders\tpostgresql",
  "ccc\tjkb-local-keycloak-1\tquay.io/keycloak/keycloak:26.0\texited\tExited (143) 2 hours ago\tjkb-local\tkeycloak",
  "ddd\tsilly_turing\tbusybox\texited\tExited (0) 3 days ago\t\t",
  "",
].join("\n");

const STATS = [
  "aaa\t12.00%\t545.2MiB / 3.827GiB",
  "bbb\t0.00%\t213.5MiB / 3.827GiB",
  "",
].join("\n");

const C = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "x", name: "x", image: "img", state: "running", status: "Up", ...over,
});

describe("parsers", () => {
  test("sizes in binary and decimal units", () => {
    expect(parseSize("545.2MiB")).toBeCloseTo(545.2 * 1024 ** 2);
    expect(parseSize(" 3.827GiB ")).toBeCloseTo(3.827 * 1024 ** 3);
    expect(parseSize("0B")).toBe(0);
    expect(parseSize("12MB")).toBe(12e6);
    expect(parseSize("lots")).toBeUndefined();
  });

  test("a container keeps its compose project and service; one started by hand has neither", () => {
    const [kafka, , , loose] = parsePs(PS);
    expect(kafka).toEqual({
      id: "aaa", name: "shop-orders-kafka-1", image: "confluentinc/cp-kafka:8.1.1", state: "running",
      status: "Up 34 hours", project: "shop-orders", service: "kafka",
    });
    expect(loose.project).toBeUndefined();
    expect(loose.service).toBeUndefined();
    expect(parsePs(PS)).toHaveLength(4);
  });

  test("stats give each container's CPU and memory", () => {
    const usage = parseStats(STATS);
    expect(usage.get("aaa")?.cpu).toBe(12);
    expect(usage.get("bbb")?.mem).toBeCloseTo(213.5 * 1024 ** 2);
  });
});

describe("run", () => {
  const engine = (p: Promise<string>) => p.then(() => "up", (e) => (e instanceof EngineUnavailable ? e.engine : "other"));

  test("a command that exits by itself is answered, whether or not it succeeds", async () => {
    expect(await run(["echo", "hi"], 5000)).toBe("hi\n");
    expect(await engine(run(["false"], 5000))).toBe("down");
  });

  test("one that does not answer in time is cut off, and one that is not there says so", async () => {
    expect(await engine(run(["sleep", "5"], 100))).toBe("slow");
    expect(await engine(run(["muxnexus-no-such-command"], 5000))).toBe("missing");
  });

  test("one that ignores the kill, or whose child holds the output open, is still given up on", async () => {
    const started = Date.now();
    expect(await engine(run(["sh", "-c", "trap '' TERM; sleep 5"], 100))).toBe("slow");
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe("reader", () => {
  function reader(outputs: Record<string, string | Error>) {
    const calls: string[] = [];
    const r = createDockerReader({
      cores: 4,
      run: async (cmd) => {
        calls.push(cmd[1]);
        const out = outputs[cmd[1]];
        if (out instanceof Error) throw out;
        return out ?? "";
      },
    });
    return { r, calls };
  }

  test("running containers carry CPU on the whole Mac's scale, and memory; the VM its size", async () => {
    const s = await reader({ ps: PS, stats: STATS, info: "4108935168\n" }).r.read();
    expect(s.engine).toBe("up");
    expect(s.containers[0]).toMatchObject({ name: "shop-orders-kafka-1", cpu: 3 }); // 12% of one core of four
    expect(s.containers[2].cpu).toBeUndefined();
    expect(s.vmMem).toBe(4108935168);
  });

  test("with nothing running, no stats are asked for", async () => {
    const { r, calls } = reader({ ps: PS.replaceAll("\trunning\t", "\texited\t"), info: "4108935168\n" });
    expect((await r.read()).vmMem).toBe(4108935168);
    expect(calls.sort()).toEqual(["info", "ps"]);
  });

  test("stats that fail leave the list standing", async () => {
    const s = await reader({ ps: PS, stats: new EngineUnavailable("slow"), info: new EngineUnavailable("slow") }).r.read();
    expect(s.engine).toBe("up");
    expect(s.containers).toHaveLength(4);
    expect(s.containers[0].cpu).toBeUndefined();
    expect(s.vmMem).toBeUndefined();
  });

  test("says why there is no list", async () => {
    expect((await reader({ ps: new EngineUnavailable("missing") }).r.read()).engine).toBe("missing");
    expect((await reader({ ps: new EngineUnavailable("slow") }).r.read()).engine).toBe("slow");
    expect((await reader({ ps: new Error("boom") }).r.read())).toEqual({ engine: "down", containers: [] });
  });
});

describe("server", () => {
  const SOCKET = "cmux-viewer-test-docker";

  async function connect(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);
    const got: ServerMessage[] = [];
    ws.onmessage = (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
    return { ws, docker: () => got.filter((m) => m.t === "docker"), send: (m: object) => ws.send(JSON.stringify(m)) };
  }

  test("reads only while a client has the tab open, and tells only that client", async () => {
    let reads = 0;
    const stats: DockerStats = { engine: "up", containers: [C()] };
    const docker = { read: async () => { reads++; return stats; } };
    const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 10_000, docker, dockerMs: 20 });
    try {
      const watcher = await connect(srv.port);
      const other = await connect(srv.port);
      await Bun.sleep(100);
      expect(reads).toBe(0);

      watcher.send({ t: "docker", on: true });
      await waitFor(() => watcher.docker().length > 2, 2000, "docker pushed while open");
      expect(watcher.docker()[0]).toEqual({ t: "docker", stats });
      expect(other.docker()).toHaveLength(0);

      watcher.send({ t: "docker", on: false });
      await Bun.sleep(60);
      const stopped = reads;
      await Bun.sleep(150);
      expect(reads).toBe(stopped);

      // A reading still fresh goes straight to whoever opens the tab next.
      other.send({ t: "docker", on: true });
      await waitFor(() => other.docker().length > 0, 2000, "reading to the joiner");
      other.ws.close();
      await Bun.sleep(60);
      const closed = reads;
      await Bun.sleep(150);
      expect(reads).toBe(closed);
    } finally {
      srv.stop();
      await new Tmux(SOCKET).killServer();
    }
  });
});

describe("panel", () => {
  test("a compose container goes by its service, numbered only past the first", () => {
    expect(containerLabel(C({ name: "shop-orders-kafka-1", service: "kafka", project: "shop-orders" }))).toBe("kafka");
    expect(containerLabel(C({ name: "shop-orders-kafka-2", service: "kafka", project: "shop-orders" }))).toBe("kafka-2");
    expect(containerLabel(C({ name: "legacy_db_1", service: "db", project: "legacy" }))).toBe("db");
    expect(containerLabel(C({ name: "silly_turing" }))).toBe("silly_turing");
  });

  test("a name set with container_name is shown as it is, number and all", () => {
    expect(containerLabel(C({ name: "web-2", service: "web", project: "shop" }))).toBe("web-2");
    expect(containerLabel(C({ name: "api-3", service: "app", project: "shop" }))).toBe("api-3");
  });

  test("groups by project: running projects first, hand-started last, running containers first in each", () => {
    const groups = groupContainers([
      C({ name: "loose" }),
      C({ name: "a-db-1", service: "db", project: "a", state: "exited" }),
      C({ name: "b-web-1", service: "web", project: "b", state: "exited" }),
      C({ name: "b-api-1", service: "api", project: "b" }),
    ]);
    expect(groups.map((g) => [g.project, g.running])).toEqual([["b", 1], ["a", 0], [undefined, 1]]);
    expect(groups[0].containers.map(containerLabel)).toEqual(["api", "web"]);
  });

  test("an engine that is down, slow or missing, or has nothing, says so instead of a list", () => {
    expect(engineNote({ engine: "down", containers: [] })).toBe("Docker is not running");
    expect(engineNote({ engine: "slow", containers: [] })).toBe("Docker is not answering");
    expect(engineNote({ engine: "missing", containers: [] })).toBe("No docker command on the PATH");
    expect(engineNote({ engine: "up", containers: [] })).toBe("No containers");
    expect(engineNote({ engine: "up", containers: [C()] })).toBeNull();
  });
});
