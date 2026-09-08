/**
 * Paramanu Seniors Notices - RSS poller
 *
 * A second file in the SENDER Apps Script project, driven by a time-based trigger rather than by a
 * person. It reads the alerts feed published by the website and sends any alert it has not sent
 * before to the notices topic.
 *
 * It does not touch sendNotice, doGet, or anything the console page calls. The web app keeps doing
 * exactly one thing; this file is a separate entry point that happens to live in the same project
 * so it can share the credentials and the Firebase plumbing that are already set up here.
 *
 * NAMING
 *   Apps Script gives every .gs file in a project one shared global scope, so two files declaring
 *   the same function name is not an error - the second silently replaces the first, and the
 *   symptom appears somewhere else entirely. Everything this file owns is therefore prefixed
 *   `poller`. The only names it reuses from Code.gs are the shared plumbing it deliberately does
 *   not duplicate:
 *
 *     property_()      accessToken_()     firebase_()     nextLogId_()     TOPIC     TOPIC_OVERRIDE
 *
 *   If you rename any of those in Code.gs, this file has to follow.
 *
 * WHAT IT DELIBERATELY DOES NOT REUSE
 *   sendNotice(), because it calls requireEditor_() and checkPin_(). A trigger has no signed-in
 *   caller and cannot type a PIN. Under an owner-installed trigger Session.getActiveUser() happens
 *   to return the owner, so requireEditor_ would pass today and start failing the day somebody else
 *   reinstalls the trigger - a failure that surfaces months later, in a cron, as silence. The
 *   poller has its own delivery function instead, and the PIN stays what it is: a human gate on the
 *   human path.
 *
 * SETUP (once)
 *  1. Paste this into the sender project as a new file, Poller.gs.
 *  2. Script Properties. SERVICE_ACCOUNT_JSON, DATABASE_URL and PROJECT_ID are already set for the
 *     sender and are reused as-is. Optionally add:
 *       ALERTS_FEED_URL    = https://paramanuseniorshealth.org/alerts/index.xml   (the default)
 *       ALERTS_MAX_PER_RUN = 5                                                    (see the ceiling)
 *  3. Run testPollerParseFixture(). No network, no credentials, sends nothing.
 *  4. Run pollerDryRun(). Reads the real feed, logs what a real run would send, sends nothing.
 *  5. Run pollerSeedFeed() ONCE. Marks every alert currently in the feed as already handled,
 *     without sending. Skip it and the first trigger run broadcasts the whole back catalogue.
 *  6. Run pollerInstallTrigger() to create the 15-minute trigger.
 *
 * Adding this file does not change the web app. There is no need to redeploy it - and redeploying
 * is worth avoiding here, since a new version resets nothing but is the step most easily done
 * half-way.
 */

var POLLER_VERSION = '2026-09-08-poller';

var POLLER_DEFAULT_FEED_URL = 'https://paramanuseniorshealth.org/alerts/index.xml';

/**
 * Most alerts the poller will send in one run.
 *
 * A ceiling, not a throttle. If something goes wrong upstream - the feed is regenerated with new
 * guids, /alertsSeen is cleared, a bulk import lands in content/alerts/ - the damage is five
 * notifications to four hundred phones instead of fifty. The rest stay unsent and visible in the
 * log, which is a problem somebody can look at rather than one that has already happened.
 */
var POLLER_MAX_PER_RUN = 5;

/** A repeat of the same guid is impossible, but a feed can still carry a title twice. */
var POLLER_SEEN_PATH = '/alertsSeen';

function pollerFeedUrl_() {
  return PropertiesService.getScriptProperties().getProperty('ALERTS_FEED_URL') || POLLER_DEFAULT_FEED_URL;
}

function pollerMaxPerRun_() {
  var configured = parseInt(PropertiesService.getScriptProperties().getProperty('ALERTS_MAX_PER_RUN'), 10);
  return (configured > 0) ? configured : POLLER_MAX_PER_RUN;
}

// ---------------------------------------------------------------- reading the feed

/**
 * Fetches the feed.
 *
 * muteHttpExceptions so a bad response is reported as a poller problem with the URL and the body
 * attached, rather than as an opaque Apps Script exception that says nothing about which fetch
 * failed.
 */
function pollerFetchFeed_(url) {
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Feed fetch failed: ' + url + ' returned ' + code + ' ' +
                    response.getContentText().slice(0, 300));
  }
  return response.getContentText();
}

/**
 * Turns the feed XML into plain objects, oldest first.
 *
 * Oldest first because they are sent in that order, so a phone that was switched off for two days
 * shows Tuesday's notice above Wednesday's rather than the reverse.
 *
 * Only an enclosure of type application/pdf becomes a pdfUrl. The app ignores images, so an image
 * enclosure is logged and dropped rather than sent as a link nothing will render.
 */
function pollerParseFeed_(xml) {
  // Built here rather than at file scope: a getNamespace call at load time runs before the project
  // has finished loading its other files, and load-order bugs in Apps Script are miserable to find.
  var contentNs = XmlService.getNamespace('content', 'http://purl.org/rss/1.0/modules/content/');

  var channel = XmlService.parse(xml).getRootElement().getChild('channel');
  if (!channel) {
    throw new Error('Feed has no channel element; is ALERTS_FEED_URL pointing at an RSS feed?');
  }

  var items = channel.getChildren('item').map(function (item) {
    var enclosure = item.getChild('enclosure');
    var url = '';
    var mime = '';
    if (enclosure) {
      var urlAttr = enclosure.getAttribute('url');
      var typeAttr = enclosure.getAttribute('type');
      url = urlAttr ? urlAttr.getValue() : '';
      mime = typeAttr ? typeAttr.getValue() : '';
    }

    var encoded = item.getChild('encoded', contentNs);

    return {
      guid: pollerText_(item, 'guid') || pollerText_(item, 'link'),
      title: pollerText_(item, 'title'),
      body: pollerText_(item, 'description'),
      link: pollerText_(item, 'link'),
      pubDate: pollerText_(item, 'pubDate'),
      html: encoded ? String(encoded.getText() || '') : '',
      enclosureUrl: url,
      enclosureType: mime,
      pdfUrl: (mime === 'application/pdf') ? url : ''
    };
  });

  // The feed is newest first, so reverse rather than sort on pubDate: the generator has already
  // ordered it, and parsing RFC-822 dates here is one more thing that can be subtly wrong.
  return items.reverse();
}

function pollerText_(element, name) {
  var child = element.getChild(name);
  return child ? String(child.getText() || '').trim() : '';
}

// ---------------------------------------------------------------- what has already gone out

/**
 * Firebase key for a guid.
 *
 * Realtime Database keys cannot contain . $ # [ ] or /, and a guid is a URL, which contains most of
 * them. Hashing rather than escaping keeps the key a fixed, predictable length, and means a guid
 * that changes shape later cannot collide with an escaped form of an older one.
 */
function pollerSeenKey_(guid) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(guid), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('').slice(0, 32);
}

function pollerIsSeen_(guid) {
  return firebase_('get', POLLER_SEEN_PATH + '/' + pollerSeenKey_(guid) + '.json?shallow=true') !== null;
}

/**
 * Records an alert as handled.
 *
 * Written under /alertsSeen, which belongs to the poller alone - the console and the sender neither
 * read nor write it. The guid and title are stored next to the hash so the table is legible to a
 * human debugging it later; a page of bare hashes tells you nothing about which notice is which.
 */
function pollerMarkSeen_(item, outcome) {
  firebase_('put', POLLER_SEEN_PATH + '/' + pollerSeenKey_(item.guid) + '.json', {
    guid: item.guid,
    title: item.title,
    pubDate: item.pubDate,
    handledAt: new Date().toISOString(),
    outcome: outcome,
    pollerVersion: POLLER_VERSION
  });
}

// ---------------------------------------------------------------- sending

/**
 * Sends one notice and records it. The poller's equivalent of sendNotice, without the human gates.
 *
 * Recorded before the send, for the same reason the sender does it that way: a notice that went out
 * but was never logged is worse than one logged and not sent, because the second is visible and the
 * first is not.
 *
 * Writes to the same /sent node as the sender, so listSent() in the console shows notices from both
 * with source: 'poller' distinguishing them. It shares nextLogId_ too, so the two cannot hand out
 * the same id - the residual race is a poller send and a human send inside the same millisecond,
 * and the loser stays unseen and is retried on the next run.
 */
function pollerDeliver_(title, body, extras) {
  title = (title || '').toString().trim();
  body = (body || '').toString().trim();

  if (!title) throw new Error('A title is required. It is what people read first, and often all they read.');
  if (title.length > 120) throw new Error('Title is too long (' + title.length + '); keep it under 120 characters.');
  if (body.length > 900) throw new Error('Body is too long (' + body.length + '); keep it under 900 characters.');

  var logId = nextLogId_();
  var sentAt = new Date().toISOString();

  var record = {
    title: title,
    body: body,
    category: 'NOTICES',
    sentAt: sentAt,
    source: 'poller',
    scriptVersion: POLLER_VERSION
  };
  for (var field in extras) {
    if (extras.hasOwnProperty(field)) record[field] = extras[field];
  }
  firebase_('put', '/sent/' + logId + '.json', record);

  // Data-only, exactly as the sender does it. A notification block here would make the FCM SDK draw
  // the tray notification itself while the app is backgrounded: onMessageReceived would never run,
  // the entitlement check would be skipped, and nothing would be written to the phone's history.
  var data = { logId: logId, title: title, body: body, category: 'NOTICES' };
  for (var extra in extras) {
    if (extras.hasOwnProperty(extra)) data[extra] = String(extras[extra]);
  }

  var message = {
    message: {
      topic: TOPIC_OVERRIDE || TOPIC,
      android: { priority: 'high' },
      data: data
    }
  };

  var response = UrlFetchApp.fetch(
    'https://fcm.googleapis.com/v1/projects/' + property_('PROJECT_ID') + '/messages:send',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + accessToken_() },
      payload: JSON.stringify(message),
      muteHttpExceptions: true
    }
  );

  if (response.getResponseCode() >= 300) {
    firebase_('patch', '/sent/' + logId + '.json', { error: response.getContentText() });
    throw new Error('FCM refused the message: ' + response.getContentText());
  }

  firebase_('patch', '/sent/' + logId + '.json', { fcmName: JSON.parse(response.getContentText()).name || '' });
  return { logId: logId, sentAt: sentAt, title: title };
}

/**
 * Sends one parsed feed item as a notice.
 *
 * Category is always NOTICES. The status topic is for the two dispensary messages, driven by a
 * person at a counter; nothing published on the website belongs on it.
 */
function pollerSendAlert_(item) {
  if (!item.title) throw new Error('Feed item has no title: ' + item.guid);

  if (!item.body) {
    // The CMS makes the summary a required field, so this should not happen. If it does, a title
    // with no body is a poor notification but a better one than nothing.
    Logger.log('Alert "%s" has no description; sending the title alone.', item.title);
  }

  var extras = {};
  if (item.pdfUrl) {
    extras.pdfUrl = item.pdfUrl;
  } else if (item.enclosureUrl) {
    Logger.log('Alert "%s" has a %s attachment, which the app ignores. Sending text only.',
               item.title, item.enclosureType);
  }

  return pollerDeliver_(item.title, item.body, extras);
}

// ---------------------------------------------------------------- the trigger entry point

/**
 * Sends every alert in the feed that has not been sent before. This is what the trigger calls.
 *
 * The lock matters more than it looks. Triggers overlap when a run is slow, and two overlapping
 * runs both see an unsent alert, both decide to send it, and four hundred people get the same
 * notice twice. Marking as seen after a successful send rather than before is the other half: an
 * alert that fails to send stays unseen and is retried on the next run.
 */
function pollAlertsFeed() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another poll run is still going; skipping this one.');
    return { skipped: true };
  }

  try {
    var items = pollerParseFeed_(pollerFetchFeed_(pollerFeedUrl_()));
    var unsent = items.filter(function (item) { return item.guid && !pollerIsSeen_(item.guid); });

    if (unsent.length === 0) {
      Logger.log('%s: %s items in feed, nothing new.', POLLER_VERSION, items.length);
      return { checked: items.length, sent: 0 };
    }

    var budget = pollerMaxPerRun_();
    if (unsent.length > budget) {
      Logger.log('WARNING: %s unsent alerts but the per-run ceiling is %s. Sending the %s oldest; ' +
                 'the rest wait for the next run. If this is not expected, run pollerStopTrigger() ' +
                 'and look at the feed before it catches up.', unsent.length, budget, budget);
      unsent = unsent.slice(0, budget);
    }

    var sent = 0;
    unsent.forEach(function (item) {
      try {
        pollerSendAlert_(item);
        pollerMarkSeen_(item, 'sent');
        sent++;
      } catch (e) {
        // Left unseen on purpose so the next run retries it, and logged rather than rethrown so one
        // bad alert does not block the ones behind it.
        Logger.log('Alert "%s" failed and will be retried: %s', item.title, e.message);
      }
    });

    Logger.log('%s: %s items in feed, %s sent.', POLLER_VERSION, items.length, sent);
    return { checked: items.length, sent: sent };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- setup and testing

/**
 * Marks everything currently in the feed as handled, without sending anything.
 *
 * Run once before the first trigger, and again after any change that alters guids. Without it, the
 * first run treats the whole back catalogue as new.
 */
function pollerSeedFeed() {
  var items = pollerParseFeed_(pollerFetchFeed_(pollerFeedUrl_()));
  items.forEach(function (item) {
    if (item.guid) pollerMarkSeen_(item, 'seeded');
  });
  Logger.log('Seeded %s items from %s. Nothing was sent.', items.length, pollerFeedUrl_());
  return items.length;
}

/**
 * Shows what the next real run would send. Sends nothing.
 *
 * The first thing to run against a feed you have just pointed at, and the thing to run again after
 * any change to the feed template.
 */
function pollerDryRun() {
  var items = pollerParseFeed_(pollerFetchFeed_(pollerFeedUrl_()));
  var unsent = items.filter(function (item) { return item.guid && !pollerIsSeen_(item.guid); });

  Logger.log('Feed: %s\n%s items, %s would be sent (ceiling %s):',
             pollerFeedUrl_(), items.length, unsent.length, pollerMaxPerRun_());
  unsent.slice(0, pollerMaxPerRun_()).forEach(function (item, i) {
    Logger.log('  %s. title : %s\n     body  : %s\n     pdfUrl: %s\n     guid  : %s',
               i + 1, item.title, item.body, item.pdfUrl || '(none)', item.guid);
  });
  return unsent.length;
}

/**
 * Parses a fixture instead of the network, and checks the fields the send path depends on.
 *
 * This is the test to run while the alerts section is still empty or undeployed: it needs no feed,
 * no credentials and no phones, and it catches the failure that actually happens in practice - a
 * change to the feed template that renames or drops a field the poller reads.
 */
function testPollerParseFixture() {
  var fixture =
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ' +
    'xmlns:content="http://purl.org/rss/1.0/modules/content/">' +
    '<channel><title>Alerts</title><link>https://paramanuseniorshealth.org/alerts/</link>' +
    '<item><title>Older alert</title>' +
    '<link>https://paramanuseniorshealth.org/alerts/2026-older/</link>' +
    '<guid isPermaLink="true">https://paramanuseniorshealth.org/alerts/2026-older/</guid>' +
    '<pubDate>Mon, 07 Sep 2026 09:00:00 +0530</pubDate>' +
    '<description>An older notice with no attachment.</description>' +
    '<content:encoded><![CDATA[<p>Body.</p>]]></content:encoded></item>' +
    '<item><title>Holiday list published</title>' +
    '<link>https://paramanuseniorshealth.org/alerts/2026-holidays/</link>' +
    '<guid isPermaLink="true">https://paramanuseniorshealth.org/alerts/2026-holidays/</guid>' +
    '<pubDate>Tue, 08 Sep 2026 10:00:00 +0530</pubDate>' +
    '<description>The list of holidays for 2026 is now available.</description>' +
    '<enclosure url="https://paramanuseniorshealth.org/files/list-of-holidays-2026.pdf" ' +
    'length="664013" type="application/pdf"/>' +
    '<content:encoded><![CDATA[<p>The <strong>list</strong> is out.</p>]]></content:encoded></item>' +
    '</channel></rss>';

  var items = pollerParseFeed_(fixture);
  var failures = [];

  function check(label, actual, expected) {
    if (String(actual) !== String(expected)) {
      failures.push(label + ': expected "' + expected + '", got "' + actual + '"');
    }
  }

  check('item count', items.length, 2);
  check('oldest first', items[0].title, 'Older alert');
  check('title', items[1].title, 'Holiday list published');
  check('body', items[1].body, 'The list of holidays for 2026 is now available.');
  check('pdfUrl', items[1].pdfUrl, 'https://paramanuseniorshealth.org/files/list-of-holidays-2026.pdf');
  check('guid', items[1].guid, 'https://paramanuseniorshealth.org/alerts/2026-holidays/');
  check('no pdf on plain item', items[0].pdfUrl, '');
  check('html decoded', items[1].html.indexOf('<strong>') >= 0, true);

  if (failures.length) {
    throw new Error('testPollerParseFixture failed:\n  ' + failures.join('\n  '));
  }
  Logger.log('testPollerParseFixture: %s items parsed, all fields correct.', items.length);
  return true;
}

/**
 * Sends the newest alert in the feed to a scratch topic, for real.
 *
 * This exercises the whole path - real credentials, real payload, real FCM response - while the
 * only thing that differs from a live send is the topic. Subscribe a test handset to 'poller-test'
 * to watch it arrive.
 *
 * It does not mark anything as seen, so it can be run repeatedly and does not consume an alert. It
 * does write to /sent, tagged source: 'poller' - that is the point, since the log write is part of
 * what is being tested. TOPIC_OVERRIDE is restored in a finally block: leaving it set would divert
 * the console's next real send to the scratch topic, and nobody would be told.
 */
function testPollerEndToEnd() {
  var items = pollerParseFeed_(pollerFetchFeed_(pollerFeedUrl_()));
  if (items.length === 0) throw new Error('Feed has no items to test with.');

  var newest = items[items.length - 1];
  TOPIC_OVERRIDE = 'poller-test';
  try {
    var result = pollerSendAlert_(newest);
    Logger.log('Sent "%s" to poller-test. logId=%s pdfUrl=%s',
               newest.title, result.logId, newest.pdfUrl || '(none)');
    return result;
  } finally {
    TOPIC_OVERRIDE = null;
  }
}

/** Proves the feed and the shared credentials both work, without sending anything. */
function testPollerConnection() {
  var items = pollerParseFeed_(pollerFetchFeed_(pollerFeedUrl_()));
  var seen = firebase_('get', POLLER_SEEN_PATH + '.json?shallow=true') || {};
  Logger.log('version=%s feed=%s items=%s alreadyHandled=%s',
             POLLER_VERSION, pollerFeedUrl_(), items.length, Object.keys(seen).length);
}

/** Creates the 15-minute trigger. Safe to run twice; it removes any existing one first. */
function pollerInstallTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollAlertsFeed') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('pollAlertsFeed').timeBased().everyMinutes(15).create();
  Logger.log('Trigger installed: pollAlertsFeed every 15 minutes.');
}

/** Removes the trigger. The first thing to reach for if something is going wrong. */
function pollerStopTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollAlertsFeed') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  Logger.log('Removed %s trigger(s).', removed);
}
