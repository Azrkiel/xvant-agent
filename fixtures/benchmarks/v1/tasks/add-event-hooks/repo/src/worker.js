export function createWorker(handler) {
  return {
    async run(queue) {
      let done = 0;
      while (queue.size() > 0) {
        await handler(queue.shift());
        done += 1;
      }
      return done;
    },
  };
}
