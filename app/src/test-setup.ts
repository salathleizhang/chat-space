import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installDomNodeInspect } from "./test-dom-inspect";

/**
 * `bun test` 的全局预载（见 app/bunfig.toml）：把 happy-dom 的 window/document/
 * localStorage 装进全局，供 storage 层与 React 组件测试用。
 * 必须在任何被测模块导入之前跑，所以走 preload 而不是在测试文件里手动 register。
 */
GlobalRegistrator.register();

/**
 * 让 DOM 节点在断言失败输出里只留一行。**必须在 register 之后**：Node 原型是 happy-dom 装进来的。
 * 不装的后果是进程直接 SIGTRAP、一行输出都没有，见 `test-dom-inspect.ts` 的实测记录。
 */
installDomNodeInspect();

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都会警告 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
