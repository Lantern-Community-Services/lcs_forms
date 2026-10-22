BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[OAuthClient] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [info] NVARCHAR(max) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OAuthClient_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OAuthClient_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OAuthCode] (
    [hash] NVARCHAR(64) NOT NULL,
    [clientId] NVARCHAR(64) NOT NULL,
    [userId] NVARCHAR(64) NOT NULL,
    [codeChallenge] NVARCHAR(255) NOT NULL,
    [redirectUri] NVARCHAR(max) NOT NULL,
    [scope] NVARCHAR(255) NOT NULL,
    [resource] NVARCHAR(max),
    [expiresAt] DATETIME2 NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OAuthCode_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OAuthCode_pkey] PRIMARY KEY CLUSTERED ([hash])
);

-- CreateTable
CREATE TABLE [dbo].[OAuthGrant] (
    [id] NVARCHAR(64) NOT NULL,
    [clientId] NVARCHAR(64) NOT NULL,
    [userId] NVARCHAR(64) NOT NULL,
    [scope] NVARCHAR(255) NOT NULL,
    [resource] NVARCHAR(max),
    [accessHash] NVARCHAR(64) NOT NULL,
    [accessExpiresAt] DATETIME2 NOT NULL,
    [refreshHash] NVARCHAR(64) NOT NULL,
    [refreshExpiresAt] DATETIME2 NOT NULL,
    [lastUsedAt] DATETIME2,
    [revokedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OAuthGrant_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OAuthGrant_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [OAuthGrant_accessHash_key] UNIQUE NONCLUSTERED ([accessHash]),
    CONSTRAINT [OAuthGrant_refreshHash_key] UNIQUE NONCLUSTERED ([refreshHash])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OAuthCode_clientId_idx] ON [dbo].[OAuthCode]([clientId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OAuthCode_userId_idx] ON [dbo].[OAuthCode]([userId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OAuthGrant_userId_idx] ON [dbo].[OAuthGrant]([userId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OAuthGrant_clientId_idx] ON [dbo].[OAuthGrant]([clientId]);

-- AddForeignKey
ALTER TABLE [dbo].[OAuthCode] ADD CONSTRAINT [OAuthCode_clientId_fkey] FOREIGN KEY ([clientId]) REFERENCES [dbo].[OAuthClient]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[OAuthCode] ADD CONSTRAINT [OAuthCode_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[OAuthGrant] ADD CONSTRAINT [OAuthGrant_clientId_fkey] FOREIGN KEY ([clientId]) REFERENCES [dbo].[OAuthClient]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[OAuthGrant] ADD CONSTRAINT [OAuthGrant_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
