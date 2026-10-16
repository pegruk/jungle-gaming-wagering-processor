import { mkdir } from "node:fs/promises";

async function check() {
  const prometheus = await fetch(
    "http://localhost:9090/api/v1/query?query=up%7Bjob%3D%22wagering%22%7D",
  );
  const grafana = await fetch("http://localhost:3001/api/dashboards/uid/wagering");
  const jaeger = await fetch(
    "http://localhost:16686/api/traces?service=wagering-processor&limit=1",
  );
  if (![prometheus, grafana, jaeger].every((response) => response.ok))
    throw new Error("Observability endpoint unavailable");
  const metric = (await prometheus.json()) as { data: { result: { value: [number, string] }[] } };
  const dashboard = (await grafana.json()) as { dashboard: { title: string; panels: unknown[] } };
  const traces = (await jaeger.json()) as { data: { spans: { operationName: string }[] }[] };
  const report = {
    checkedAt: new Date().toISOString(),
    prometheusScrapeUp: metric.data.result.some((row) => row.value[1] === "1"),
    grafanaDashboard: dashboard.dashboard.title,
    grafanaPanels: dashboard.dashboard.panels.length,
    jaegerTracesReturned: traces.data.length,
    spanNames: traces.data.flatMap((entry) => entry.spans.map((span) => span.operationName)),
  };
  if (!report.prometheusScrapeUp || report.grafanaPanels < 1 || report.jaegerTracesReturned < 1)
    throw new Error(
      "Expected metrics/dashboard/traces not found; generate a request with OTEL_ENABLED=true first",
    );
  await mkdir("reports", { recursive: true });
  await Bun.write("reports/observability-check.json", JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
await check();
