import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const app = createApp({ cfg, log: (line) => console.log(JSON.stringify(line)) });
app.listen(cfg.port, () => console.log(`gateway listening on ${cfg.port}`));
