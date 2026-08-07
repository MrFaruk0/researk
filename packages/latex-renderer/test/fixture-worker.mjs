import { parentPort, workerData } from "node:worker_threads";

const attempt = Atomics.add(new Int32Array(workerData.state), 0, 1);
parentPort.postMessage({ type: "ready" });
parentPort.on("message", (request) => {
  if (attempt === 0 && workerData.first === "timeout") return;
  if (attempt === 0 && workerData.first === "crash") throw new Error("synthetic crash");
  if (attempt === 0 && workerData.first === "protocol") {
    parentPort.postMessage({ type: "internal-secret", detail: request.tex });
    return;
  }
  parentPort.postMessage({
    type: "result",
    id: request.id,
    result: {
      display: request.display,
      renderer: "mathjax-4.1.3",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
      tex: request.tex,
    },
  });
});
