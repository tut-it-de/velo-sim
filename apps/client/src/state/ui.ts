import { Store } from './store';

/** App-level UI flags (e.g. hide the sidebar and top bar while riding). */
export const uiStore = new Store<{ immersive: boolean }>({ immersive: false });

export type Page = 'ride' | 'workouts' | 'garage' | 'activities' | 'devices' | 'shifting' | 'settings' | 'login';

/** The page shown next to the sidebar. */
export const pageStore = new Store<Page>('ride');
