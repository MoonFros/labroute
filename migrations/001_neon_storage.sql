-- All mutable state is shared across instances. No JSON manifest read/modify/write.
CREATE TABLE labroute_settings (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE labroute_admins (
  email text PRIMARY KEY,
  password_hash text NOT NULL CHECK (password_hash ~ '^[a-f0-9]{64}$')
);

CREATE TABLE labroute_documents (
  path text PRIMARY KEY,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE labroute_publication_order;

CREATE TABLE labroute_moments (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  caption text NOT NULL,
  contributor text NOT NULL DEFAULT '',
  image_path text,
  image_data bytea,
  ext text,
  mime text,
  width integer,
  height integer,
  bytes integer NOT NULL DEFAULT 0,
  tall boolean NOT NULL DEFAULT true,
  uploaded boolean NOT NULL DEFAULT false,
  uploaded_at timestamptz,
  approved_at timestamptz,
  publication_order bigint,
  archive_order integer NOT NULL DEFAULT 0,
  CHECK (status <> 'pending' OR (image_data IS NOT NULL AND ext IS NOT NULL AND mime IS NOT NULL)),
  CHECK (status <> 'approved' OR image_path IS NOT NULL),
  CHECK (image_data IS NULL OR octet_length(image_data) = bytes)
);

CREATE INDEX labroute_pending_order ON labroute_moments (uploaded_at DESC, id)
  WHERE status = 'pending';
CREATE INDEX labroute_gallery_order ON labroute_moments
  ((COALESCE(approved_at, uploaded_at)) DESC, publication_order DESC, archive_order)
  WHERE status = 'approved';
CREATE UNIQUE INDEX labroute_image_path ON labroute_moments (image_path)
  WHERE status = 'approved';

-- Only HMACs, never raw visitor identifiers or IP addresses.
CREATE TABLE labroute_rate_events (
  key text NOT NULL,
  occurred_at bigint NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY (key, event_id)
);
CREATE INDEX labroute_rate_lookup ON labroute_rate_events (key, occurred_at);
CREATE INDEX labroute_rate_retention ON labroute_rate_events (occurred_at);

CREATE TABLE labroute_login_attempts (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at bigint NOT NULL
);
CREATE INDEX labroute_login_retention ON labroute_login_attempts (reset_at);

CREATE TABLE labroute_notifications (
  id bigserial PRIMARY KEY,
  source_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  body jsonb NOT NULL
);
