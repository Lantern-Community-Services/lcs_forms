BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[ClientDocument] (
    [id] NVARCHAR(64) NOT NULL,
    [tenantId] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64),
    [kind] NVARCHAR(40) NOT NULL,
    [label] NVARCHAR(200),
    [name] NVARCHAR(255) NOT NULL,
    [mime] NVARCHAR(255) NOT NULL,
    [size] INT NOT NULL,
    [data] VARBINARY(max),
    [storageKey] NVARCHAR(512),
    [createdById] NVARCHAR(64),
    [createdByName] NVARCHAR(255) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ClientDocument_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [removedAt] DATETIME2,
    [removedById] NVARCHAR(64),
    [removedByName] NVARCHAR(255),
    CONSTRAINT [ClientDocument_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ClientDocument_tenantId_removedAt_idx] ON [dbo].[ClientDocument]([tenantId], [removedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_tenantId_formId_idx] ON [dbo].[FormEntry]([tenantId], [formId]);

-- AddForeignKey
ALTER TABLE [dbo].[ClientDocument] ADD CONSTRAINT [ClientDocument_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
