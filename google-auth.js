import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signOut
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

(() => {
  'use strict';

  const GUIDE_URL = 'https://github.com/harunobushishido-boop/stopwatch/blob/main/GOOGLE_LOGIN_SETUP.md';
  const config = window.PC_FIREBASE_CONFIG || {};
  const root = document.documentElement;

  const isPlaceholder = (value) => !value || /PASTE_|YOUR_PROJECT_ID|YOUR_APP_ID|your-project/i.test(String(value));
  const configured = ['apiKey', 'authDomain', 'projectId', 'appId'].every((key) => !isPlaceholder(config[key]));

  let auth = null;
  let loginButton = null;
  let logoutButton = null;
  let statusNode = null;
  let profileNode = null;
  let errorNode = null;
  let currentUser = null;

  const setStatus = (message, isError = false) => {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.style.color = isError ? '#b91c1c' : '';
    statusNode.setAttribute('aria-live', 'polite');
  };

  const setError = (message) => {
    if (!errorNode) return;
    errorNode.textContent = message || '';
    errorNode.hidden = !message;
  };

  const messageForError = (error) => {
    const code = String(error && error.code || '');
    if (code.includes('unauthorized-domain')) return 'Firebase Authenticationの承認済みドメインに harunobushishido-boop.github.io を追加してください。';
    if (code.includes('operation-not-allowed')) return 'Firebase ConsoleでGoogleログインを有効にしてください。';
    if (code.includes('popup-blocked')) return 'ポップアップがブロックされました。ブラウザーで許可して再試行してください。';
    if (code.includes('popup-closed-by-user')) return 'ログイン画面が閉じられました。必要ならもう一度お試しください。';
    if (code.includes('network-request-failed')) return 'ネットワークに接続できません。通信状態を確認してください。';
    return 'ログインできませんでした。Firebaseの設定と承認済みドメインを確認してください。';
  };

  function renderUser(user) {
    currentUser = user || null;
    if (window.PC_AUTH) {
      window.PC_AUTH.currentUser = currentUser;
      window.PC_AUTH.enabled = Boolean(auth);
    }
    if (profileNode) {
      profileNode.replaceChildren();
      if (user) {
        if (user.photoURL) {
          const avatar = document.createElement('img');
          avatar.src = user.photoURL;
          avatar.alt = '';
          avatar.referrerPolicy = 'no-referrer';
          avatar.style.cssText = 'width:38px;height:38px;border-radius:50%;object-fit:cover;flex:0 0 auto';
          profileNode.appendChild(avatar);
        }
        const textWrap = document.createElement('div');
        textWrap.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:3px';
        const name = document.createElement('strong');
        name.textContent = user.displayName || 'Googleユーザー';
        name.style.cssText = 'font-size:13px;overflow-wrap:anywhere';
        const email = document.createElement('span');
        email.textContent = user.email || '';
        email.style.cssText = 'font-size:12px;opacity:.75;overflow-wrap:anywhere';
        textWrap.append(name, email);
        profileNode.appendChild(textWrap);
        setStatus('Googleアカウントでログイン中');
      } else if (configured) {
        setStatus('ログインしていません');
      } else {
        setStatus('ログインの初期設定が必要です');
      }
    }
    if (loginButton) loginButton.hidden = Boolean(user);
    if (logoutButton) logoutButton.hidden = !user;
    window.dispatchEvent(new CustomEvent('pc-auth-changed', {
      detail: { signedIn: Boolean(user), user: user ? { uid: user.uid, displayName: user.displayName || '', email: user.email || '', photoURL: user.photoURL || '' } : null }
    }));
  }

  function createButton(label, primary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = 'padding:9px 13px;border:1px solid ' + (primary ? '#2563eb' : 'currentColor') + ';border-radius:10px;background:' + (primary ? '#2563eb' : 'transparent') + ';color:' + (primary ? '#fff' : 'inherit') + ';font:inherit;font-size:13px;font-weight:600;cursor:pointer';
    return button;
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
    note.textContent = 'Googleアカウントでログインします。スプレッドシートへのアクセスは別途、連携ボタンから許可します。';
    statusNode = document.createElement('p');
    statusNode.style.cssText = 'margin:8px 0;font-size:12.5px;line-height:1.5';
    profileNode = document.createElement('div');
    profileNode.style.cssText = 'display:flex;align-items:center;gap:10px;margin:10px 0;min-height:4px';
    errorNode = document.createElement('p');
    errorNode.style.cssText = 'color:#b91c1c;margin:6px 0;font-size:12px;line-height:1.5';
    errorNode.hidden = true;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    loginButton = createButton('Googleでログイン', true);
    logoutButton = createButton('ログアウト');
    logoutButton.hidden = true;
    const guide = document.createElement('a');
    guide.href = GUIDE_URL;
    guide.target = '_blank';
    guide.rel = 'noopener noreferrer';
    guide.textContent = '初期設定ガイド';
    guide.style.cssText = 'font-size:12px;color:inherit;text-decoration:underline;text-underline-offset:3px';
    actions.append(loginButton, logoutButton, guide);
    const small = document.createElement('p');
    small.className = 'clk-group__hint';
    small.style.marginTop = '10px';
    small.textContent = 'この機能を有効にするには、Firebaseプロジェクトを作成し、firebase-config.jsにWebアプリ設定を記入する必要があります。';
    group.append(title, note, statusNode, profileNode, errorNode, actions, small);
    const footnote = pane.querySelector('.clk-panel__footnote');
    pane.insertBefore(group, footnote || null);

    loginButton.addEventListener('click', async () => {
      setError('');
      if (!configured || !auth) {
        setError('まだFirebase設定が入っていません。初期設定ガイドに沿ってfirebase-config.jsを設定してください。');
        return;
      }
      loginButton.disabled = true;
      loginButton.textContent = 'ログイン中…';
      try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        if (window.matchMedia('(max-width: 720px)').matches) {
          await signInWithRedirect(auth, provider);
        } else {
          await signInWithPopup(auth, provider);
        }
      } catch (error) {
        setError(messageForError(error));
        console.error('Google sign-in failed', error);
      } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Googleでログイン';
      }
    });

    logoutButton.addEventListener('click', async () => {
      setError('');
      if (!auth) return;
      try {
        await signOut(auth);
      } catch (error) {
        setError('ログアウトできませんでした。通信状態を確認してください。');
        console.error('Google sign-out failed', error);
      }
    });

    renderUser(null);
    if (!configured) {
      loginButton.disabled = false;
      return;
    }
    try {
      auth = getApps().length ? getAuth(getApp()) : getAuth(initializeApp(config));
      window.PC_AUTH = {
        auth,
        get currentUser() { return auth.currentUser; },
        getIdToken: async () => auth.currentUser ? auth.currentUser.getIdToken() : null,
        signOut: () => signOut(auth),
        get enabled() { return Boolean(auth); }
      };
      setPersistence(auth, browserLocalPersistence).catch((error) => console.warn('Auth persistence setup failed', error));
      onAuthStateChanged(auth, renderUser, (error) => {
        setError(messageForError(error));
        setStatus('認証状態を確認できません', true);
      });
      getRedirectResult(auth).catch((error) => {
        if (error) setError(messageForError(error));
      });
    } catch (error) {
      setError('Firebaseを初期化できませんでした。firebase-config.jsの設定内容を確認してください。');
      setStatus('Firebase初期化エラー', true);
      console.error('Firebase init failed', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installUI, { once: true });
  } else {
    installUI();
  }
})();