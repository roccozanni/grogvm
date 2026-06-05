// Bootstrap for `/play` — mount the player island. (Stage 3 replaces this thin
// caller with a generator-injected script from docs/play.md frontmatter.)
import '../../src/styles/index.css';
import { mount } from '../../src/app/player';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');
mount(root);
