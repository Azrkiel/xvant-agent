import { SimulatedAdapter } from '../../../packages/adapters/src/simulated/index.ts';
import {
  parse,
  runRequestSchema,
} from '../../../packages/contracts/src/index.ts';
const envelope = JSON.parse(process.argv[2] ?? 'null') as {
  request: unknown;
  token: string;
  generation: number;
};
const request = parse(runRequestSchema, envelope.request);
for await (const event of new SimulatedAdapter().run(request)) {
  process.stdout.write(
    JSON.stringify({
      token: envelope.token,
      generation: envelope.generation,
      event,
    }) + '\n',
  );
}
