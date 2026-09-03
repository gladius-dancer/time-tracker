/** Runs the same smoke test under the real Electron runtime. */
import { app } from 'electron';

import { runSmoke } from './smoke';

app
  .whenReady()
  .then(runSmoke)
  .then((code) => app.exit(code))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
