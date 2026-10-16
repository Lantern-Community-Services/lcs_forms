BEGIN TRY

BEGIN TRAN;

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_siteId_occurredAt_idx] ON [dbo].[FormEntry]([formId], [siteId], [occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_createdById_createdAt_idx] ON [dbo].[FormEntry]([createdById], [createdAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
