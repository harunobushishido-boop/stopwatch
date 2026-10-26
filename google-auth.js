(() => {
  'use strict';

  const GUIDE_URL = 'https://github.com/harunobushishido-boop/stopwatch/blob/main/GOOGLE_LOGIN_SETUP.md';
  const config = window.PC_GOOGLE_LOGIN_CONFIG || {};
  const clientId = String(config.clientId || '').trim();
  const configured = clientId.endsWith('.apps.googleusercontent.com') &&
    !/PASTE_|YOUR_PROJECT|YOUR_CLIENT/i.test(clientId);

  const AUTH_PROFILE_CACHE_KEY = 'pc-google-login-profile-v1';
  const AUTH_PROFILE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

  function readCachedProfile() {
    try {
      const cached = JSON.parse(localStorage.getItem(AUTH_PROFILE_CACHE_KEY) || 'null');
      if (!cached || !cached.user || !Number.isFinite(Number(cached.savedAt)) ||
          Date.now() - Number(cached.savedAt) > AUTH_PROFILE_MAX_AGE ||
          Number(cached.savedAt) > Date.now() + 60000) {
        localStorage.removeItem(AUTH_PROFILE_CACHE_KEY);
        return null;
      }
      const user = cached.user;
      if (!user.sub || !user.email) return null;
      return {
        sub: String(user.sub),
        name: String(user.name || ''),
        email: String(user.email || ''),
        picture: String(user.picture || ''),
        emailVerified: user.emailVerified === true,
        expiresAt: 0,
        verifiedByServer: false,
        restoredFromCache: true
      };
    } catch (error) {
      return null;
    }
  }

  function saveCachedProfile(user) {
    if (!user || !user.sub || !user.email) return;
    try {
      // Store only display/profile details. Never persist OAuth access or ID tokens.
      localStorage.setItem(AUTH_PROFILE_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        user: {
          sub: String(user.sub),
          name: String(user.name || ''),
          email: String(user.email || ''),
          picture: String(user.picture || ''),
          emailVerified: user.emailVerified === true
        }
      }));
    } catch (error) {}
  }

  let currentUser = readCachedProfile();
  let googleIdTokenSeen = false;
  let accessToken = '';
  let accessTokenExpiresAt = 0;
  let tokenClient = null;
  const AUTH_SCOPES = 'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';
  let container = null;
  let statusNode = null;
  let profileNode = null;
  let errorNode = null;
  let signOutButton = null;

  const setStatus = (message, error = false) => {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.style.color = error ? '#b91c1c' : '';
    statusNode.setAttribute('aria-live', 'polite');
  };

  const setError = (message) => {
    if (!errorNode) return;
    errorNode.textContent = message || '';
    errorNode.hidden = !message;
  };

  const guideLink = () => {
    const a = document.createElement('a');
    a.href = GUIDE_URL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '初期設定ガイド';
    a.style.cssText = 'font-size:12px;color:inherit;text-decoration:underline;text-underline-offset:3px';
    return a;
  };

  function decodePayload(idToken) {
    const pieces = String(idToken || '').split('.');
    if (pieces.length !== 3) throw new Error('GoogleのIDトークン形式が不正です。');
    const base64 = pieces[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function publishState(user, options = {}) {
    currentUser = user || null;
    if (currentUser && options.persist !== false) saveCachedProfile(currentUser);
    if (!currentUser && options.clearCache) {
      try { localStorage.removeItem(AUTH_PROFILE_CACHE_KEY); } catch (error) {}
    }
    if (profileNode) {
      profileNode.replaceChildren();
      if (currentUser) {
        if (currentUser.picture) {
          const avatar = document.createElement('img');
          avatar.src = currentUser.picture;
          avatar.alt = '';
          avatar.referrerPolicy = 'no-referrer';
          avatar.style.cssText = 'width:38px;height:38px;border-radius:50%;object-fit:cover;flex:0 0 auto';
          profileNode.appendChild(avatar);
        }
        const details = document.createElement('div');
        details.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:3px';
        const name = document.createElement('strong');
        name.textContent = currentUser.name || 'Googleユーザー';
        name.style.cssText = 'font-size:13px;overflow-wrap:anywhere';
        const email = document.createElement('span');
        email.textContent = currentUser.email || '';
        email.style.cssText = 'font-size:12px;opacity:.75;overflow-wrap:anywhere';
        details.append(name, email);
        profileNode.appendChild(details);
        setStatus(accessToken && Date.now() < accessTokenExpiresAt ? 'Google接続済み・スプレッドシートを利用できます' : 'Googleアカウントは保存済みです。接続状態を自動確認しています。');
        if (signOutButton) signOutButton.hidden = false;
      } else {
        setStatus(configured ? 'Googleアカウントにログインしていません' : '初期設定が必要です');
        if (signOutButton) signOutButton.hidden = true;
      }
    }

    window.PC_AUTH = {
      configured,
      get currentUser() { return currentUser; },
      get signedIn() { return Boolean(currentUser); },
      // GIS sends an ID token directly to this page. A server must verify its signature
      // before using it for protected resources or permissions.
      frontendOnly: true,
      getAccessToken: () => accessToken && Date.now() < accessTokenExpiresAt ? accessToken : '',
      getAccessTokenExpiresAt: () => accessTokenExpiresAt,
      signOut: () => {
        currentUser = null;
        googleIdTokenSeen = false;
        accessToken = '';
        accessTokenExpiresAt = 0;
        try { window.google?.accounts?.id?.disableAutoSelect(); } catch (error) {}
        try { window.google?.accounts?.id?.cancel(); } catch (error) {}
        publishState(null, { clearCache: true });
      }
    };

    window.dispatchEvent(new CustomEvent('pc-auth-changed', {
      detail: {
        signedIn: Boolean(currentUser),
        frontendOnly: true,
        user: currentUser ? {
          sub: currentUser.sub,
          name: currentUser.name || '',
          email: currentUser.email || '',
          picture: currentUser.picture || ''
        } : null
      }
    }));
  }

  function handleCredentialResponse(response) {
    setError('');
    try {
      if (!response || !response.credential) throw new Error('GoogleからIDトークンが返されませんでした。');
      const claims = decodePayload(response.credential);
      const now = Math.floor(Date.now() / 1000);
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) {
        throw new Error('Google IDトークンの発行元が一致しません。');
      }
      if (claims.aud !== clientId) throw new Error('Google OAuthクライアントIDが一致しません。');
      if (!claims.sub || !claims.exp || Number(claims.exp) <= now) throw new Error('Google IDトークンが期限切れ、または不完全です。');

      // Display-only client state: do not persist or transmit the ID token.
      googleIdTokenSeen = true;
      publishState({
        sub: String(claims.sub),
        name: String(claims.name || ''),
        email: String(claims.email || ''),
        picture: String(claims.picture || ''),
        emailVerified: claims.email_verified === true,
        expiresAt: Number(claims.exp),
        verifiedByServer: false
      });
      setError('');
    } catch (error) {
      setError(error.message || 'Googleでログインできませんでした。');
      setStatus('ログインに失敗しました', true);
      console.error('GIS credential handling failed', error);
    }
  }

  function loadGIS() {
    if (window.google?.accounts?.id) return Promise.resolve();
    if (window.__pcGoogleGISPromise) return window.__pcGoogleGISPromise;
    window.__pcGoogleGISPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => window.google?.accounts?.id
        ? resolve()
        : reject(new Error('Google Identity Servicesを初期化できませんでした。'));
      script.onerror = () => reject(new Error('Google Identity Servicesを読み込めませんでした。ネットワークを確認してください。'));
      document.head.appendChild(script);
    });
    return window.__pcGoogleGISPromise;
  }

  let tokenRequestActive = false;
  let silentAccessAttempt = false;
  function requestGoogleAccess(silent = false) {
    if (!tokenClient || tokenRequestActive) return false;
    silentAccessAttempt = !!silent;
    tokenRequestActive = true;
    try {
      tokenClient.requestAccessToken(silent ? { prompt: '' } : { prompt: 'consent' });
      return true;
    } catch (error) {
      tokenRequestActive = false;
      silentAccessAttempt = false;
      if (!silent) {
        setError(error.message || 'Google認証を開始できませんでした。');
        setStatus('Google認証を開始できません', true);
      }
      return false;
    }
  }

  async function initializeGoogleSignIn() {
    if (!configured || !container) return;
    try {
      await loadGIS();
      if (!container.isConnected) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = currentUser ? 'Googleへのアクセスを再接続' : 'Googleアカウントでログインして接続';
      button.style.cssText = 'padding:10px 13px;border:1px solid #4285f4;border-radius:9px;background:#4285f4;color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer';
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: AUTH_SCOPES,
        callback: async (response) => {
          const wasSilent = silentAccessAttempt;
          silentAccessAttempt = false;
          tokenRequestActive = false;
          try {
            if (!response || !response.access_token) {
              if (wasSilent) {
                setStatus(currentUser
                  ? '保存済みのGoogleアカウントを確認しました。シート接続に失敗した場合は「Googleへのアクセスを再接続」を押してください。'
                  : 'Googleスプレッドシートを使うには、Googleアカウントで接続してください。');
                return;
              }
              throw new Error(response && (response.error_description || response.error) || 'Googleからアクセス許可を取得できませんでした。');
            }
            accessToken = response.access_token;
            accessTokenExpiresAt = Date.now() + Math.max(60, Number(response.expires_in || 3600) - 60) * 1000;
            const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: 'Bearer ' + accessToken },
              cache: 'no-store'
            });
            if (!profileResponse.ok) throw new Error('Googleアカウント情報を取得できませんでした（HTTP ' + profileResponse.status + '）。');
            const profile = await profileResponse.json();
            if (!profile || !profile.sub || !profile.email) throw new Error('Googleアカウント情報が不完全です。');
            publishState({
              sub: String(profile.sub),
              name: String(profile.name || ''),
              email: String(profile.email || ''),
              picture: String(profile.picture || ''),
              emailVerified: profile.email_verified === true,
              expiresAt: Math.floor(accessTokenExpiresAt / 1000),
              verifiedByServer: false
            });
            setError('');
            setStatus('Google接続済み。スプレッドシートへのアクセス許可を確認しました。');
          } catch (error) {
            accessToken = '';
            accessTokenExpiresAt = 0;
            if (!wasSilent) {
              setError(error.message || 'Google接続に失敗しました。');
              setStatus('Google接続に失敗しました', true);
            } else {
              setStatus(currentUser
                ? 'Googleアカウントは保存されています。接続を復旧できない場合は、Googleへのアクセスを再接続してください。'
                : 'Googleへの接続が必要です。');
            }
          } finally {
            button.disabled = false;
            button.textContent = currentUser ? 'Googleへのアクセスを再接続' : 'Googleアカウントでログインして接続';
          }
        },
        error_callback: (error) => {
          const wasSilent = silentAccessAttempt;
          silentAccessAttempt = false;
          tokenRequestActive = false;
          button.disabled = false;
          button.textContent = currentUser ? 'Googleへのアクセスを再接続' : 'Googleアカウントでログインして接続';
          if (wasSilent) {
            setStatus(currentUser
              ? '保存済みのGoogleアカウントがあります。自動接続できない場合は「Googleへのアクセスを再接続」を押してください。'
              : 'Googleスプレッドシートを使うときは、Googleアカウントで接続してください。');
            return;
          }
          setError(error && error.message || 'Googleの認証画面を開けませんでした。');
          setStatus('Google認証に失敗しました', true);
        }
      });
      window.__pcGoogleRequestAccess = requestGoogleAccess;
      window.__pcGoogleAccessIsPending = () => tokenRequestActive;
      button.addEventListener('click', () => {
        setError('');
        if (tokenRequestActive) return;
        button.disabled = true;
        button.textContent = 'Googleに接続中…';
        if (!requestGoogleAccess(false)) {
          button.disabled = false;
          button.textContent = currentUser ? 'Googleへのアクセスを再接続' : 'Googleアカウントでログインして接続';
        }
      });
      container.replaceChildren(button);
      if (currentUser) {
        setStatus('保存済みのGoogleアカウントを確認中です。');
        // OAuth access tokens expire after a short time and are intentionally not stored.
        // Reuse the user's previous Google grant quietly when the browser permits it.
        requestGoogleAccess(true);
      } else {
        setStatus('Googleアカウントで接続すると、予定表と授業時間数を自動で確認します。');
      }
    } catch (error) {
      setError(error.message || 'Googleログインを初期化できませんでした。');
      setStatus('Googleログインを利用できません', true);
    }
  }

  function installUI() {
    const panes = [...document.querySelectorAll('.clk-panel__pane')];
    const pane = panes.find((item) => item.querySelector('[aria-label="フォントの太さ"]')) || panes[5];
    if (!pane || document.getElementById('pcGoogleLoginGroup')) return;

    const group = document.createElement('section');
    group.id = 'pcGoogleLoginGroup';
    group.className = 'clk-group';
    group.style.cssText = 'padding:14px;border:1px solid var(--clk-fg,#1e40af);border-radius:14px;margin-top:12px';
    const title = document.createElement('div');
    title.className = 'clk-group__label';
    title.textContent = 'Googleアカウント';
    const note = document.createElement('p');
    note.className = 'clk-group__hint';
    note.textContent = 'Googleログイン時に、アカウント情報・スプレッドシート連携・このアプリで使用する特定のGoogleドライブファイルへのアクセス権限を、Google公式画面で確認・許可します。';
    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:8px 0;font-size:12.5px;line-height:1.5';
    profileNode = document.createElement('div');
    profileNode.style.cssText = 'display:flex;align-items:center;gap:10px;margin:10px 0;min-height:4px';
    errorNode = document.createElement('p');
    errorNode.style.cssText = 'color:#b91c1c;margin:6px 0;font-size:12px;line-height:1.5';
    errorNode.hidden = true;
    container = document.createElement('div');
    container.id = 'pcGoogleSignInButton';
    container.style.cssText = 'min-height:44px;display:flex;align-items:center;flex-wrap:wrap;margin-top:8px';
    signOutButton = document.createElement('button');
    signOutButton.type = 'button';
    signOutButton.textContent = 'ログアウト';
    signOutButton.hidden = true;
    signOutButton.style.cssText = 'padding:8px 12px;border:1px solid currentColor;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;margin-top:8px';
    signOutButton.addEventListener('click', () => window.PC_AUTH?.signOut?.());
    const note2 = document.createElement('p');
    note2.className = 'clk-group__hint';
    note2.style.marginTop = '9px';
    note2.textContent = '許可するのは、このアプリからGoogleスプレッドシートAPIを利用する権限です。ドライブ内の全ファイルを自由に操作する権限ではありません。このGitHub Pages版のログイン状態はブラウザー内のみで、サーバーによる本人確認は行いません。';
    const guideRow = document.createElement('div');
    guideRow.style.cssText = 'margin-top:8px';
    guideRow.appendChild(guideLink());
    group.append(title, note, statusNode, profileNode, errorNode, container, signOutButton, guideRow, note2);
    const footnote = pane.querySelector('.clk-panel__footnote');
    pane.insertBefore(group, footnote || null);
    // Restore the remembered account label, without pretending the short-lived API token survived.
    publishState(currentUser, { persist: false });

    if (!configured) {
      setError('Google CloudでOAuth 2.0のウェブアプリ クライアントIDを作成し、google-login-config.jsに設定してください。');
      return;
    }
    initializeGoogleSignIn();
  }

  window.PC_AUTH = {
    configured,
    get currentUser() { return currentUser; },
    get signedIn() { return Boolean(currentUser); },
    frontendOnly: true,
    getAccessToken: () => accessToken && Date.now() < accessTokenExpiresAt ? accessToken : '',
    getAccessTokenExpiresAt: () => accessTokenExpiresAt,
    signOut: () => {
      currentUser = null;
      accessToken = '';
      accessTokenExpiresAt = 0;
      try { window.google?.accounts?.id?.disableAutoSelect(); } catch (error) {}
      publishState(null, { clearCache: true });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installUI, { once: true });
  } else {
    installUI();
  }
})();