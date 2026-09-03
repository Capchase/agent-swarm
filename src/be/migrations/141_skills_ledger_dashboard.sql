-- Skills ledger dashboard. Seeds a table widget reading skill.outcome events.
-- The 'data.family' = 'feedback' filter inside the widget SQL is the
-- open-decision knob from the approved plan; currently 'feedback'.

INSERT OR IGNORE INTO metrics (agentId, slug, title, description, definition)
VALUES
  (
    'system',
    'skills-ledger',
    'Skills ledger',
    'Per-skill run/pass/fail/unreacted counts and the 20-run 90% graduation gate, from the skill.invoke / skill.outcome event ledger.',
    '{"version":1,"refreshSeconds":60,"layout":{"columns":1},"variables":[],"widgets":[{"id":"skills-ledger-graduation","title":"Skills ledger","description":"Runs, passes, fails, unreacted, and graduation status per skill, from the feedback family of the skills ledger.","query":{"sql":"WITH runs AS (\n  SELECT json_extract(data, ''$.skillName'') AS skill, taskId\n  FROM events\n  WHERE category = ''skill'' AND event = ''skill.invoke''\n),\nlatest AS (\n  SELECT json_extract(data, ''$.skillName'') AS skill,\n         taskId,\n         json_extract(data, ''$.outcome'') AS outcome,\n         json_extract(data, ''$.removed'') AS removed,\n         ROW_NUMBER() OVER (\n           PARTITION BY taskId, json_extract(data, ''$.skillName'')\n           ORDER BY createdAt DESC, id DESC\n         ) AS rn\n  FROM events\n  WHERE category = ''skill'' AND event = ''skill.outcome''\n    AND json_extract(data, ''$.family'') = ''feedback''\n)\nSELECT r.skill,\n       COUNT(*) AS runs,\n       SUM(CASE WHEN l.outcome = ''pass'' AND l.removed = 0 THEN 1 ELSE 0 END) AS passes,\n       SUM(CASE WHEN l.outcome = ''fail'' AND l.removed = 0 THEN 1 ELSE 0 END) AS fails,\n       SUM(CASE WHEN l.outcome IS NULL OR l.removed = 1 THEN 1 ELSE 0 END) AS unreacted,\n       CASE\n         WHEN COUNT(*) >= 20\n          AND SUM(CASE WHEN l.outcome = ''pass'' AND l.removed = 0 THEN 1 ELSE 0 END) * 1.0\n              / NULLIF(SUM(CASE WHEN l.removed = 0\n                             AND l.outcome IN (''pass'', ''fail'') THEN 1 ELSE 0 END), 0) >= 0.9\n         THEN 1 ELSE 0\n       END AS graduated\nFROM runs r\nLEFT JOIN latest l ON l.taskId = r.taskId AND l.skill = r.skill AND l.rn = 1\nGROUP BY r.skill;","maxRows":200},"viz":{"type":"table","columns":[{"key":"skill","label":"Skill"},{"key":"runs","label":"Runs","format":"integer"},{"key":"passes","label":"Passes","format":"integer"},{"key":"fails","label":"Fails","format":"integer"},{"key":"unreacted","label":"Unreacted","format":"integer"},{"key":"graduated","label":"Graduated","format":"integer"}]}}]}'
  );
