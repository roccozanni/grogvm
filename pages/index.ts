// Bootstrap for `/` — mount the library island. (Stage 3 replaces this thin
// caller with a generator-injected script from docs/index.md frontmatter.)
import '../src/styles/index.css';
import { mount } from '../src/app/library';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');
mount(root);
