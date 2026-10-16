export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const timeout = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, 30000);
  let content = "";
  try {
    while (!content.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Process exited before becoming ready");
      content += new TextDecoder().decode(chunk.value);
    }
    return content.split("\n")[0]!;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
