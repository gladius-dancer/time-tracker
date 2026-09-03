/** Runs the smoke test under plain Node; the build aliases `electron` to a stub. */
import { runSmoke } from './smoke';

runSmoke()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
