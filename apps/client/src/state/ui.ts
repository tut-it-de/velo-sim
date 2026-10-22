import { Store } from './store';

/** App-level UI flags (e.g. hide the sidebar and top bar while riding). */
export const uiStore = new Store<{ immersive: boolean }>({ immersive: false });

export type Page = 'ride' | 'routes' | 'workouts' | 'garage' | 'activities' | 'devices' | 'settings' | 'login';

/** The page shown next to the sidebar. */
export const pageStore = new Store<Page>('ride');

/** Text in the top bar search; filters the route list. */
export const searchStore = new Store<string>('');
