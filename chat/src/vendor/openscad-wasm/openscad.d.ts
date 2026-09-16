/** 官方 Emscripten 胶水层的最小类型面：只声明 cadOps 用到的部分 */
export interface OpenSCADInstance {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, data: string | Uint8Array): void;
    readFile(path: string): Uint8Array;
    mkdir(path: string): void;
  };
}

export interface OpenSCADInitOptions {
  noInitialRun?: boolean;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  locateFile?: (file: string) => string;
}

export default function OpenSCAD(
  options?: OpenSCADInitOptions,
): Promise<OpenSCADInstance>;
