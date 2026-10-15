import { Store } from './store';

/** App-level UI flags (e.g. hide the top bar while riding). */
export const uiStore = new Store<{ immersive: boolean }>({ immersive: false });
