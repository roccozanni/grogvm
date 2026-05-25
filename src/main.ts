import './styles.css';
import { App } from './shell/app';
import { checkBrowserSupport, renderUnsupported } from './shell/browser-support';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}

const unsupported = checkBrowserSupport();
if (unsupported) {
  root.appendChild(renderUnsupported(unsupported));
} else {
  new App(root).start();
}
