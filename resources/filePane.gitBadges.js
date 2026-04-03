'use strict';
(function () {
  const INCOMING_TITLE = 'Incoming changes (upstream)';

  /**
   * @param {{ letter?: string, kind?: string } | null | undefined} incoming
   * @returns {HTMLSpanElement | null}
   */
  function incomingPairElement(incoming) {
    if (!incoming || !incoming.letter) return null;
    const ik = incoming.kind || 'modified';
    const span = document.createElement('span');
    span.className = 'git-incoming-pair git-incoming-pair--' + ik;
    span.textContent = '\u2193' + incoming.letter;
    span.title = INCOMING_TITLE;
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', 'Incoming ' + ik);
    return span;
  }

  /**
   * @param {{ primary?: { letter?: string }, secondary?: { letter?: string } } | null | undefined} git
   * @param {boolean} isFolder
   */
  function rowHasLocalGitLetters(git, isFolder) {
    if (!git) return false;
    return !!(
      (git.primary && git.primary.letter) ||
      (!isFolder && git.secondary && git.secondary.letter)
    );
  }

  /**
   * @param {HTMLElement} container
   * @param {{ primary?: { letter?: string }, secondary?: { letter?: string }, incoming?: { letter?: string } } | null | undefined} git
   * @param {boolean} isFolder
   */
  function appendCommaBetweenIncomingAndLocal(container, git, isFolder) {
    if (!isFolder && git && git.incoming && git.incoming.letter && rowHasLocalGitLetters(git, isFolder)) {
      container.appendChild(document.createTextNode(', '));
    }
  }

  globalThis.FilePaneGitBadges = {
    incomingPairElement,
    rowHasLocalGitLetters,
    appendCommaBetweenIncomingAndLocal,
  };
})();
