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

  /** Matches folder roll-up priority in `gitFileStatusService.ts` (higher = more “interesting”). */
  const GIT_KIND_RANK = {
    conflict: 100,
    deleted: 90,
    modified: 70,
    renamed: 65,
    copied: 60,
    added: 50,
    untracked: 40,
    ignored: 10,
  };

  /**
   * @param {{ letter?: string, kind?: string } | null | undefined} badge
   * @returns {number}
   */
  function gitBadgeRank(badge) {
    if (!badge || !badge.letter) return 0;
    const k = badge.kind;
    if (k && Object.prototype.hasOwnProperty.call(GIT_KIND_RANK, k)) {
      return GIT_KIND_RANK[k];
    }
    return 30;
  }

  /**
   * Combined Git + Problems rank for Status column sort (Git dominates; problems break ties).
   * @param {{ git?: { primary?: { letter?: string, kind?: string }, secondary?: { letter?: string, kind?: string }, incoming?: { letter?: string, kind?: string } }, problems?: { errors?: number, warnings?: number, infos?: number } }} row
   * @returns {number}
   */
  function rowStatusSortKey(row) {
    let gitRank = 0;
    const git = row && row.git;
    if (git) {
      gitRank = Math.max(gitBadgeRank(git.primary), gitBadgeRank(git.secondary), gitBadgeRank(git.incoming));
    }
    const pr = row && row.problems;
    let probRank = 0;
    if (pr) {
      probRank = (pr.errors || 0) * 100 + (pr.warnings || 0) * 10 + (pr.infos || 0);
    }
    return gitRank * 10000 + probRank;
  }

  globalThis.FilePaneGitBadges = {
    incomingPairElement,
    rowHasLocalGitLetters,
    appendCommaBetweenIncomingAndLocal,
    rowStatusSortKey,
  };
})();
