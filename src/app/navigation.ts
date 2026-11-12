import { useCallback, useEffect, useState } from 'react';

export const PAGE_PATHS = {
    home: '/home',
    tasks: '/tasks',
    group: '/groups',
    settings: '/settings',
    login: '/login',
    register: '/register',
    authenticator: '/login/authenticator',
    recovery: '/forgot-password',
    join: '/join',
    approval: '/account-pending',
    accounts: '/accounts',
} as const;
export type PortalPage = 'home' | 'tasks' | 'group' | 'settings' | 'accounts';
export type SitePage = keyof typeof PAGE_PATHS | 'not-found';

const legacyPages: Record<string, keyof typeof PAGE_PATHS> = {
    tasks: 'tasks',
    home: 'home',
    group: 'group',
    groups: 'group',
    settings: 'settings',
    account: 'settings',
    login: 'login',
    register: 'register',
};
const aliases: Record<string, string> = {
    '/': '/home',
    '/index.html': '/home',
    '/group': '/groups',
    '/account': '/settings',
    '/signup': '/register',
    '/setup-admin': '/login',
};

export function resolveRoute(location: { pathname: string; search: string; hash: string }) {
    let pathname = location.pathname.replace(/\/+$/, '') || '/';
    let hash = location.hash;
    const fragment = hash.slice(1);
    const legacyPage = Object.hasOwn(legacyPages, fragment) ? legacyPages[fragment] : undefined;
    if (legacyPage && (pathname in aliases || Object.values(PAGE_PATHS).some((path) => path === pathname))) {
        pathname = PAGE_PATHS[legacyPage];
        hash = '';
    }
    pathname = aliases[pathname] ?? pathname;
    const page = (Object.entries(PAGE_PATHS).find(([, path]) => path === pathname)?.[0] ??
        'not-found') as SitePage;
    return { page, pathname, search: location.search, hash, href: pathname + location.search + hash };
}

export function isPortalPage(page: SitePage): page is PortalPage {
    return (
        page === 'home' || page === 'tasks' || page === 'group' || page === 'settings' || page === 'accounts'
    );
}

export function signInDestination(search: string): string {
    const next = new URLSearchParams(search).get('next');
    if (
        next === '/home' ||
        next === '/tasks' ||
        next === '/groups' ||
        next === '/settings' ||
        next === '/accounts'
    )
        return next;
    if (
        next &&
        /^\/join\?invite=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#token=[A-Za-z0-9_-]{43}$/i.test(
            next,
        )
    )
        return next;
    return '/home';
}

const GOOGLE_RETURN_KEY = 'manhunt_google_return';

export function rememberGoogleReturn(mode: 'login' | 'register' | 'link') {
    try {
        window.sessionStorage.removeItem(GOOGLE_RETURN_KEY);
        if (mode === 'login')
            window.sessionStorage.setItem(GOOGLE_RETURN_KEY, signInDestination(window.location.search));
    } catch {}
}

export function consumeGoogleReturn(): string {
    try {
        const next = window.sessionStorage.getItem(GOOGLE_RETURN_KEY);
        window.sessionStorage.removeItem(GOOGLE_RETURN_KEY);
        return signInDestination(`?next=${encodeURIComponent(next ?? '')}`);
    } catch {
        return '/home';
    }
}

export function useNavigation() {
    const [route, setRoute] = useState(() => resolveRoute(window.location));
    const navigateUrl = useCallback((href: string, replace = false) => {
        const target = new URL(href, window.location.origin);
        if (target.origin !== window.location.origin) throw new Error('Use an internal page URL.');
        const next = resolveRoute(target);
        if (next.href !== window.location.pathname + window.location.search + window.location.hash) {
            window.history[replace ? 'replaceState' : 'pushState'](null, '', next.href);
        }
        setRoute(next);
    }, []);

    useEffect(() => {
        const sync = () => {
            const next = resolveRoute(window.location);
            if (next.href !== window.location.pathname + window.location.search + window.location.hash) {
                window.history.replaceState(null, '', next.href);
            }
            setRoute(next);
        };
        sync();
        window.addEventListener('popstate', sync);
        window.addEventListener('hashchange', sync);
        return () => {
            window.removeEventListener('popstate', sync);
            window.removeEventListener('hashchange', sync);
        };
    }, []);

    return { route, navigateUrl };
}
