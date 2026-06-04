import { runVector1 } from "./scenarios/vector1";
import { runVector2 } from "./scenarios/vector2";
import { runVector3 } from "./scenarios/vector3";
import { runVector4 } from "./scenarios/vector4";

const vector = process.argv[2];
const seed = process.env.SEED ? parseInt(process.env.SEED, 10) : 42;

const runners: Record<string, (seed: number) => Promise<void>> = {
  vector1: runVector1,
  vector2: runVector2,
  vector3: runVector3,
  vector4: runVector4,
};

if (!runners[vector]) {
  console.error("Usage: ts-node src/index.ts <vector1|vector2|vector3|vector4>");
  console.error("       SEED=42 ts-node src/index.ts vector1");
  process.exit(1);
}

console.log(`[testbed] Running ${vector} with seed=${seed}`);
runners[vector](seed)
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(`[testbed] ${vector} failed:`, e);
    process.exit(1);
  });
