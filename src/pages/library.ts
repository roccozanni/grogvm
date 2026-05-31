// Entry for `/` — the library (and the in-page install flow).
import '../styles.css';
import { App } from '../shell/app';
import { mountPage } from './shared';

mountPage((root) => new App(root).start());
