-- Lantern Forms – application database user
-- Run once per environment, connected to the app database (sqldb-forms-<env>) as the Entra admin.
-- The server is Entra-only; this is a contained database user, not a server login.
-- Replace the password with a generated value (openssl rand -base64 32) and store the resulting
-- connection string in Key Vault as DATABASE-URL. Never commit the password.

CREATE USER forms_app WITH PASSWORD = '<generated-password>';
ALTER ROLE db_datareader ADD MEMBER forms_app;
ALTER ROLE db_datawriter ADD MEMBER forms_app;
ALTER ROLE db_ddladmin  ADD MEMBER forms_app;   -- required by prisma migrate deploy

-- Rotation:
-- ALTER USER forms_app WITH PASSWORD = '<new-password>';
-- then update DATABASE-URL in Key Vault and restart app-forms-api-<env>.
