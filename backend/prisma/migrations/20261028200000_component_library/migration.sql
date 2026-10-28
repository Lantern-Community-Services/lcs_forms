BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[UiComponent] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(80) NOT NULL,
    [title] NVARCHAR(160) NOT NULL,
    [description] NVARCHAR(max) NOT NULL,
    [category] NVARCHAR(60) NOT NULL,
    [files] NVARCHAR(max) NOT NULL,
    [api] NVARCHAR(max),
    [usage] NVARCHAR(max),
    [version] INT NOT NULL CONSTRAINT [UiComponent_version_df] DEFAULT 1,
    [createdByName] NVARCHAR(255) NOT NULL,
    [updatedByName] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [UiComponent_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [UiComponent_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UiComponent_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[UiComponentVersion] (
    [id] NVARCHAR(64) NOT NULL,
    [componentId] NVARCHAR(64) NOT NULL,
    [version] INT NOT NULL,
    [files] NVARCHAR(max) NOT NULL,
    [note] NVARCHAR(max),
    [createdByName] NVARCHAR(255) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [UiComponentVersion_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [UiComponentVersion_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UiComponentVersion_componentId_version_key] UNIQUE NONCLUSTERED ([componentId],[version])
);

-- AddForeignKey
ALTER TABLE [dbo].[UiComponentVersion] ADD CONSTRAINT [UiComponentVersion_componentId_fkey] FOREIGN KEY ([componentId]) REFERENCES [dbo].[UiComponent]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

