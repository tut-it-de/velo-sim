import { Store } from './store';

/** App-level UI flags (e.g. hide the top bar while riding). */
export const uiStore = new Store<{ immersive: boolean }>({ immersive: false });

export type Page = 'ride' | 'garage' | 'activities' | 'devices' | 'settings' | 'login';

/** The page shown below the top bar. */
export const pageStore = new Store<Page>('ride');
