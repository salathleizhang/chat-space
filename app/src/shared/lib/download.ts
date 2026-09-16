/** 触发浏览器保存一个内存 Blob（批量导出等拿到 zip/文件 Blob 后落盘用） */
export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
