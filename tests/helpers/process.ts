export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let content = "";
  try {
    while (!content.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Process exited before becoming ready");
      content += new TextDecoder().decode(chunk.value);
    }
    return content.split("\n")[0]!;
  } finally {
    reader.releaseLock();
  }
}
