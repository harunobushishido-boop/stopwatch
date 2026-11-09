(() => {
  'use strict';

  // Google authentication is intentionally disabled in this static build.
  // Shared-note editing, local saving, sharing links, and voice announcements
  // do not require a Google account or Google Drive/Sheets permissions.
  window.PC_AUTH = Object.freeze({
    configured: false,
    currentUser: null,
    signedIn: false,
    frontendOnly: true,
    getAccessToken: () => '',
    getAccessTokenExpiresAt: () => 0,
    signOut: () => {}
  });
})();