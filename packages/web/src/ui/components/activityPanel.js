// The Activity panel — what is running, and what is stuck.
//
// Two sections, because they are two different kinds of fact and the user acts on them
// differently. Running work is watched and possibly cancelled; a standing problem is
// retried or dismissed. Merging them into one "notifications" list would lose that:
// a task that finished is over, while an issue that is listed is still true right now.
//
// A task that doesn't know its total renders as an indeterminate bar rather than a
// guess. Nothing here fabricates a percentage.

import { dd } from '../../runtime.js';
import { icon } from '../icon.js';
import { bytes } from '../format.js';
import { CancelTaskAction, CopyTextAction, DismissIssueAction, DismissTaskAction, ExecCommandAction, RetryIssueAction, ToggleActivityPanelAction } from '../../bl/actions.js';

const { div, button, span, h3, p, pre } = dd;

const STATUS_ICON = { running: 'refresh', done: 'check', failed: 'close', cancelled: 'close' };

/**
 * Clipboard, with the value shown if the write is refused.
 *
 * Clipboard permission is denied often enough that a button which silently does nothing
 * reads as broken — and the remedy is the one thing on this panel the user has to get out
 * of the app and into a terminal.
 */
function copyText(text, ui) {
  ui.engine.dispatch(new CopyTextAction(text));
}

function amount(task) {
  if (task.total == null) return null;
  return task.unit === 'bytes'
    ? `${bytes(task.done || 0)} of ${bytes(task.total)}`
    : `${task.done || 0} of ${task.total}${task.unit ? ` ${task.unit}` : ''}`;
}

function taskRow(task, ui) {
  const running = task.status === 'running';
  const determinate = running && task.total != null && task.total > 0;
  const pct = determinate ? Math.min(100, Math.round(((task.done || 0) / task.total) * 100)) : 0;
  return div({ className: `act-task act-${task.status}`, 'data-task-id': task.id },
    div({ className: 'act-row' },
      running
        ? div({ className: 'spinner', $styling: { width: '12px', height: '12px' } })
        : icon(STATUS_ICON[task.status] || 'info', { size: 13 }),
      div({ className: 'act-body' },
        div({ className: 'act-title' }, task.title),
        task.detail ? div({ className: 'act-detail' }, task.detail) : null,
        task.error ? div({ className: 'act-error' }, task.error) : null,
      ),
      running && task.cancellable
        ? button({ className: 'act-action', title: 'Cancel' }, icon('close', { size: 12 })).on({ click: () => ui.engine.dispatch(new CancelTaskAction(task.id)) })
        : !running
          ? button({ className: 'act-action', title: 'Dismiss' }, icon('close', { size: 12 })).on({ click: () => ui.engine.dispatch(new DismissTaskAction(task.id)) })
          : null,
    ),
    running
      // An indeterminate bar animates without claiming a position. The alternative —
      // picking a number — would be a lie dressed as information.
      ? div({ className: `act-bar ${determinate ? '' : 'indeterminate'}` },
        div({ className: 'act-fill', $styling: determinate ? { width: `${pct}%` } : {} }))
      : null,
    running && amount(task) ? div({ className: 'act-amount' }, amount(task)) : null,
  );
}

function issueRow(issue, ui) {
  const since = new Date(issue.firstAt || issue.lastAt).toLocaleString();
  return div({ className: `act-issue act-sev-${issue.severity || 'error'}`, 'data-issue-id': issue.id },
    div({ className: 'act-row' },
      icon(issue.severity === 'warning' ? 'info' : 'close', { size: 13 }),
      div({ className: 'act-body' },
        div({ className: 'act-title' }, issue.title),
        issue.detail ? div({ className: 'act-detail' }, issue.detail) : null,
        // The fix, kept apart from the description and rendered as-is. A remedy is often
        // a policy document or a shell command, and a problem report that describes the
        // fix in prose leaves the reader to retype it.
        issue.remedy ? pre({ className: 'act-remedy' }, issue.remedy) : null,
        div({ className: 'act-meta' }, issue.count > 1 ? `${issue.count} times, since ${since}` : `since ${since}`),
      ),
    ),
    div({ className: 'act-actions' },
      issue.remedy
        ? button({ className: 'btn small ghost' }, 'Copy fix')
          .on({ click: () => copyText(issue.remedy, ui) })
        : null,
      // Retry only when the server said pressing it will actually do something.
      issue.retryable
        ? button({ className: 'btn small act-retry' }, icon('refresh', { size: 12 }), span('Retry'))
          .on({ click: () => ui.engine.dispatch(new RetryIssueAction(issue.id)) })
        : null,
      button({ className: 'btn small ghost act-dismiss' }, 'Dismiss')
        .on({ click: () => ui.engine.dispatch(new DismissIssueAction(issue.id)) }),
    ),
  );
}

export default function activityPanel(state, ui) {
  const act = state.act || { tasks: [], issues: [] };
  if (!act.open) return null;
  const running = act.tasks.filter((t) => t.status === 'running');
  const recent = act.tasks.filter((t) => t.status !== 'running');

  return div({ className: 'activity-panel' },
    div({ className: 'act-head' },
      h3('Activity'),
      button({ className: 'act-action', title: 'Close' }, icon('close', { size: 13 }))
        .on({ click: () => ui.engine.dispatch(new ToggleActivityPanelAction(false)) }),
    ),

    // "Nothing is wrong" and "we couldn't ask" look identical unless one says so. Both
    // loads are reported, because either can fail alone.
    act.tasksError || act.issuesError
      ? div({ className: 'act-offline' }, icon('info', { size: 12 }),
        span(`Couldn't reach the server — this list may be out of date (${act.issuesError || act.tasksError})`))
      : null,

    div({ className: 'act-section' },
      div({ className: 'act-section-title' }, 'Running'),
      running.length
        ? div(...running.map((t) => taskRow(t, ui)))
        : p({ className: 'act-empty' }, 'Nothing running.'),
    ),

    act.issues.length
      ? div({ className: 'act-section' },
        div({ className: 'act-section-title' }, `Needs attention (${act.issues.length})`),
        div(...act.issues.map((i) => issueRow(i, ui))),
      )
      : div({ className: 'act-section' },
        div({ className: 'act-section-title' }, 'Needs attention'),
        // An unreadable list is not an empty one, and must never render as "all clear".
        p({ className: 'act-empty' },
          act.issuesError ? 'Could not load the list of problems.' : act.issuesLoading ? 'Checking…' : 'No standing problems.'),
      ),

    recent.length
      ? div({ className: 'act-section' },
        div({ className: 'act-section-title' }, 'Recently finished'),
        div(...recent.map((t) => taskRow(t, ui))),
      )
      : null,

    div({ className: 'act-foot act-actions' },
      button({ className: 'btn small ghost act-rebuild' }, icon('refresh', { size: 12 }), span('Rebuild search index'))
        .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.rebuildIndex')) }),
      button({ className: 'btn small ghost act-scan' }, icon('refresh', { size: 12 }), span('Scan for outside changes'))
        .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.scanCollection')) }),
      // On demand as well as on a schedule, because the moment an admin wants to know
      // whether they fixed the bucket is right after they changed it — not up to five
      // minutes later. It also checks against THIS browser's origin, which the scheduled
      // run can only do if the deployment configured one.
      button({ className: 'btn small ghost act-storage' }, icon('plug', { size: 12 }), span('Check storage'))
        .on({ click: () => ui.engine.dispatch(new ExecCommandAction('workbench.checkStorage')) }),
    ),
  );
}
