BEGIN TRY

BEGIN TRAN;

-- Entries saved without a clientId (imports, the MCP server) get one: their own id, unique already.
UPDATE [dbo].[FormEntry] SET [clientId] = [id] WHERE [clientId] IS NULL;

-- An upload already saved twice (two retries that raced past the duplicate
-- check): every copy is kept, and the later ones get a clientId of their own so
-- the unique key below can be added. Nothing is deleted.
WITH [copies] AS (
    SELECT [id], [clientId], ROW_NUMBER() OVER (PARTITION BY [formId], [clientId] ORDER BY [createdAt], [id]) AS [n]
    FROM [dbo].[FormEntry]
)
UPDATE [copies] SET [clientId] = [clientId] + N':dup:' + [id] WHERE [n] > 1;

-- DropIndex
DROP INDEX [FormEntry_clientId_idx] ON [dbo].[FormEntry];

-- AlterTable
ALTER TABLE [dbo].[FormEntry] ALTER COLUMN [clientId] NVARCHAR(255) NOT NULL;

-- CreateIndex
ALTER TABLE [dbo].[FormEntry] ADD CONSTRAINT [FormEntry_formId_clientId_key] UNIQUE NONCLUSTERED ([formId], [clientId]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
