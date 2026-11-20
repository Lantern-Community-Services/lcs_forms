BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[FormDraft] (
    [id] NVARCHAR(64) NOT NULL,
    [formId] NVARCHAR(64) NOT NULL,
    [userId] NVARCHAR(64) NOT NULL,
    [formVersion] INT NOT NULL,
    [values] NVARCHAR(max) NOT NULL,
    [siteCode] NVARCHAR(80),
    [label] NVARCHAR(120) NOT NULL,
    [page] INT NOT NULL CONSTRAINT [FormDraft_page_df] DEFAULT 0,
    [writer] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormDraft_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [FormDraft_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormDraft_userId_formId_updatedAt_idx] ON [dbo].[FormDraft]([userId], [formId], [updatedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormDraft_updatedAt_idx] ON [dbo].[FormDraft]([updatedAt]);

-- AddForeignKey
ALTER TABLE [dbo].[FormDraft] ADD CONSTRAINT [FormDraft_formId_fkey] FOREIGN KEY ([formId]) REFERENCES [dbo].[BuiltForm]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormDraft] ADD CONSTRAINT [FormDraft_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

