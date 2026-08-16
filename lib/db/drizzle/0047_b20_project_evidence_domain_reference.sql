-- A claiming DOMAIN is a valid evidence reference.
--
-- 0046 allowed a reference to be an https URL or a bare address, which covers
-- every probe: a website, a product endpoint, a repository, a contract. It does
-- not cover the one reference the identity finding carries — the domain the
-- claim was proven against, which is `miorail.xyz` and not `https://miorail.xyz`.
--
-- Caught by the constraint on the first production write, which is the
-- constraint doing its job. Widened here rather than by writing the domain as a
-- URL: `https://miorail.xyz` would name the project's WEBSITE, and the identity
-- finding is not about a website. Two different things should not share one
-- string because one of them fits a regex.
--
-- The shape stays tight. A bare lowercase hostname with at least one dot is the
-- only addition; anything that could carry a credential, a scheme or a path is
-- still refused.

ALTER TABLE b20_project_evidence
  DROP CONSTRAINT IF EXISTS b20_project_evidence_reference_shape;

ALTER TABLE b20_project_evidence
  ADD CONSTRAINT b20_project_evidence_reference_shape CHECK (
    reference IS NULL
    OR reference ~ '^https://'
    OR reference ~ '^0x[0-9a-fA-F]{40}$'
    OR reference ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  );
