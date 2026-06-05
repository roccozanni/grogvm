// Bootstrap for `/explore` — mount the explorer island. (Stage 3 replaces this
// thin caller with a generator-injected script from docs/explore.md frontmatter.)
import '../../src/styles/index.css';
import { mount } from '../../src/app/explorer';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');
mount(root);
