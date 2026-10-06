-- Lantern Forms — Azure SQL (SQL Server) schema.
-- Generated from backend/prisma/schema.prisma by `npm run sql:azure`. Do not edit by hand.

BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Site] (
    [id] NVARCHAR(64) NOT NULL,
    [code] NVARCHAR(255) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [entityName] NVARCHAR(255),
    [siteType] NVARCHAR(255) NOT NULL CONSTRAINT [Site_siteType_df] DEFAULT 'supportive',
    [address] NVARCHAR(max),
    [latitude] FLOAT(53),
    [longitude] FLOAT(53),
    [geofenceMeters] INT,
    [active] BIT NOT NULL CONSTRAINT [Site_active_df] DEFAULT 1,
    [attentionHours] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Site_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Site_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Site_code_key] UNIQUE NONCLUSTERED ([code])
);

-- CreateTable
CREATE TABLE [dbo].[Tenant] (
    [id] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [unit] NVARCHAR(255),
    [firstName] NVARCHAR(255) NOT NULL,
    [lastName] NVARCHAR(255) NOT NULL CONSTRAINT [Tenant_lastName_df] DEFAULT '',
    [preferredName] NVARCHAR(255),
    [status] NVARCHAR(255) NOT NULL CONSTRAINT [Tenant_status_df] DEFAULT 'active',
    [moveInDate] DATETIME2,
    [moveOutDate] DATETIME2,
    [notes] NVARCHAR(max),
    [externalId] NVARCHAR(64),
    [lastActivityAt] DATETIME2,
    [lastActivitySource] NVARCHAR(255),
    [lastKeptAt] DATETIME2,
    [lastKeptById] NVARCHAR(64),
    [attentionClockAt] DATETIME2 NOT NULL CONSTRAINT [Tenant_attentionClockAt_df] DEFAULT CURRENT_TIMESTAMP,
    [archivedAt] DATETIME2,
    [archivedById] NVARCHAR(64),
    [archiveReason] NVARCHAR(255),
    [version] INT NOT NULL CONSTRAINT [Tenant_version_df] DEFAULT 1,
    [createdById] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Tenant_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Tenant_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TenantActivity] (
    [id] NVARCHAR(64) NOT NULL,
    [tenantId] NVARCHAR(64) NOT NULL,
    [source] NVARCHAR(255) NOT NULL,
    [label] NVARCHAR(255),
    [externalRef] NVARCHAR(255),
    [occurredAt] DATETIME2 NOT NULL,
    [recordedBy] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TenantActivity_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [TenantActivity_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AuditEvent] (
    [id] NVARCHAR(64) NOT NULL,
    [actorId] NVARCHAR(64),
    [actorName] NVARCHAR(255) NOT NULL,
    [action] NVARCHAR(255) NOT NULL,
    [tenantId] NVARCHAR(64),
    [siteId] NVARCHAR(64),
    [summary] NVARCHAR(max) NOT NULL,
    [changes] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AuditEvent_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AuditEvent_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AttendanceEvent] (
    [id] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [title] NVARCHAR(255) NOT NULL,
    [description] NVARCHAR(max) NOT NULL,
    [occurredAt] DATETIME2 NOT NULL CONSTRAINT [AttendanceEvent_occurredAt_df] DEFAULT CURRENT_TIMESTAMP,
    [createdById] NVARCHAR(64),
    [createdByName] NVARCHAR(255) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AttendanceEvent_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AttendanceEvent_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AttendanceEntry] (
    [id] NVARCHAR(64) NOT NULL,
    [eventId] NVARCHAR(64) NOT NULL,
    [tenantId] NVARCHAR(64) NOT NULL,
    [tenantName] NVARCHAR(255) NOT NULL,
    [signature] NVARCHAR(max),
    [signedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AttendanceEntry_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AttendanceEntry_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AttendanceEntry_eventId_tenantId_key] UNIQUE NONCLUSTERED ([eventId],[tenantId])
);

-- CreateTable
CREATE TABLE [dbo].[HotFoodItem] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [imageUrl] NVARCHAR(max),
    [active] BIT NOT NULL CONSTRAINT [HotFoodItem_active_df] DEFAULT 1,
    [sortOrder] INT NOT NULL CONSTRAINT [HotFoodItem_sortOrder_df] DEFAULT 0,
    [colorSlot] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [HotFoodItem_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [HotFoodItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[HotFoodEntry] (
    [id] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    [tenantId] NVARCHAR(64) NOT NULL,
    [tenantName] NVARCHAR(255) NOT NULL,
    [unit] NVARCHAR(255),
    [mealCount] INT NOT NULL,
    [notes] NVARCHAR(max),
    [overrideReason] NVARCHAR(max),
    [signature] NVARCHAR(max) NOT NULL,
    [source] NVARCHAR(255) NOT NULL CONSTRAINT [HotFoodEntry_source_df] DEFAULT 'app',
    [occurredAt] DATETIME2 NOT NULL CONSTRAINT [HotFoodEntry_occurredAt_df] DEFAULT CURRENT_TIMESTAMP,
    [clientId] NVARCHAR(64),
    [createdById] NVARCHAR(64),
    [createdByName] NVARCHAR(255) NOT NULL,
    [voidedAt] DATETIME2,
    [voidedById] NVARCHAR(64),
    [voidedByName] NVARCHAR(255),
    [voidReason] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [HotFoodEntry_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [HotFoodEntry_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[HotFoodEntryItem] (
    [id] NVARCHAR(64) NOT NULL,
    [entryId] NVARCHAR(64) NOT NULL,
    [itemId] NVARCHAR(64),
    [itemName] NVARCHAR(255) NOT NULL,
    [quantity] INT NOT NULL,
    CONSTRAINT [HotFoodEntryItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarCategory] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [colorSlot] INT NOT NULL CONSTRAINT [CalendarCategory_colorSlot_df] DEFAULT 0,
    [sortOrder] INT NOT NULL CONSTRAINT [CalendarCategory_sortOrder_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CalendarCategory_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CalendarCategory_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarCategoryMute] (
    [userId] NVARCHAR(64) NOT NULL,
    [categoryId] NVARCHAR(64) NOT NULL,
    CONSTRAINT [CalendarCategoryMute_pkey] PRIMARY KEY CLUSTERED ([userId],[categoryId])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarEvent] (
    [id] NVARCHAR(64) NOT NULL,
    [title] NVARCHAR(255) NOT NULL,
    [description] NVARCHAR(max),
    [location] NVARCHAR(255),
    [categoryId] NVARCHAR(64),
    [allSites] BIT NOT NULL CONSTRAINT [CalendarEvent_allSites_df] DEFAULT 1,
    [allDay] BIT NOT NULL CONSTRAINT [CalendarEvent_allDay_df] DEFAULT 0,
    [startDate] NVARCHAR(255) NOT NULL,
    [startTime] NVARCHAR(255),
    [endDate] NVARCHAR(255) NOT NULL,
    [endTime] NVARCHAR(255),
    [recurrence] NVARCHAR(max),
    [teamsMeeting] BIT NOT NULL CONSTRAINT [CalendarEvent_teamsMeeting_df] DEFAULT 0,
    [firstDate] NVARCHAR(255) NOT NULL,
    [lastDate] NVARCHAR(255),
    [createdById] NVARCHAR(64),
    [createdByName] NVARCHAR(255) NOT NULL,
    [updatedByName] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CalendarEvent_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    [outlookEventId] NVARCHAR(64),
    [teamsJoinUrl] NVARCHAR(255),
    [outlookDirty] BIT NOT NULL CONSTRAINT [CalendarEvent_outlookDirty_df] DEFAULT 1,
    [outlookError] NVARCHAR(255),
    [outlookSyncedAt] DATETIME2,
    [outlookHash] NVARCHAR(255),
    CONSTRAINT [CalendarEvent_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarEventSite] (
    [eventId] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    CONSTRAINT [CalendarEventSite_pkey] PRIMARY KEY CLUSTERED ([eventId],[siteId])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarFollow] (
    [userId] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    CONSTRAINT [CalendarFollow_pkey] PRIMARY KEY CLUSTERED ([userId],[siteId])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarCopy] (
    [id] NVARCHAR(64) NOT NULL,
    [eventId] NVARCHAR(64) NOT NULL,
    [userId] NVARCHAR(64) NOT NULL,
    [mailbox] NVARCHAR(255) NOT NULL,
    [outlookEventId] NVARCHAR(64),
    [hash] NVARCHAR(64),
    [fallbackInvite] BIT NOT NULL CONSTRAINT [CalendarCopy_fallbackInvite_df] DEFAULT 0,
    [error] NVARCHAR(max),
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CalendarCopy_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CalendarCopy_eventId_userId_key] UNIQUE NONCLUSTERED ([eventId],[userId])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarOutlookTrash] (
    [id] NVARCHAR(64) NOT NULL,
    [mailbox] NVARCHAR(255),
    [outlookEventId] NVARCHAR(64) NOT NULL,
    [title] NVARCHAR(255) NOT NULL,
    [error] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CalendarOutlookTrash_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CalendarOutlookTrash_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CalendarException] (
    [id] NVARCHAR(64) NOT NULL,
    [eventId] NVARCHAR(64) NOT NULL,
    [originalDate] NVARCHAR(255) NOT NULL,
    [cancelled] BIT NOT NULL CONSTRAINT [CalendarException_cancelled_df] DEFAULT 0,
    [title] NVARCHAR(255),
    [description] NVARCHAR(max),
    [location] NVARCHAR(255),
    [allDay] BIT,
    [startDate] NVARCHAR(255),
    [startTime] NVARCHAR(255),
    [endDate] NVARCHAR(255),
    [endTime] NVARCHAR(255),
    [updatedByName] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CalendarException_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CalendarException_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CalendarException_eventId_originalDate_key] UNIQUE NONCLUSTERED ([eventId],[originalDate])
);

-- CreateTable
CREATE TABLE [dbo].[FormCategory] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [icon] NVARCHAR(255) NOT NULL CONSTRAINT [FormCategory_icon_df] DEFAULT 'folder',
    [sortOrder] INT NOT NULL CONSTRAINT [FormCategory_sortOrder_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormCategory_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [FormCategory_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[FormLink] (
    [id] NVARCHAR(64) NOT NULL,
    [categoryId] NVARCHAR(64) NOT NULL,
    [title] NVARCHAR(255) NOT NULL,
    [description] NVARCHAR(max),
    [url] NVARCHAR(max) NOT NULL,
    [keywords] NVARCHAR(255),
    [badge] NVARCHAR(255),
    [icon] NVARCHAR(255),
    [sortOrder] INT NOT NULL CONSTRAINT [FormLink_sortOrder_df] DEFAULT 0,
    [active] BIT NOT NULL CONSTRAINT [FormLink_active_df] DEFAULT 1,
    [roles] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormLink_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [FormLink_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[FormFavorite] (
    [userId] NVARCHAR(64) NOT NULL,
    [formId] NVARCHAR(64) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormFavorite_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [FormFavorite_pkey] PRIMARY KEY CLUSTERED ([userId],[formId])
);

-- CreateTable
CREATE TABLE [dbo].[BuiltForm] (
    [id] NVARCHAR(64) NOT NULL,
    [kind] NVARCHAR(255) NOT NULL CONSTRAINT [BuiltForm_kind_df] DEFAULT 'basic',
    [slug] NVARCHAR(255) NOT NULL,
    [title] NVARCHAR(255) NOT NULL,
    [status] NVARCHAR(255) NOT NULL CONSTRAINT [BuiltForm_status_df] DEFAULT 'draft',
    [draftSchema] NVARCHAR(255) NOT NULL,
    [liveSchema] NVARCHAR(255),
    [liveVersion] INT NOT NULL CONSTRAINT [BuiltForm_liveVersion_df] DEFAULT 0,
    [revision] INT NOT NULL CONSTRAINT [BuiltForm_revision_df] DEFAULT 1,
    [catalogLinkId] NVARCHAR(64),
    [homeAction] BIT NOT NULL CONSTRAINT [BuiltForm_homeAction_df] DEFAULT 0,
    [createdById] NVARCHAR(64),
    [createdByName] NVARCHAR(255) NOT NULL,
    [updatedByName] NVARCHAR(255),
    [publishedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [BuiltForm_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [BuiltForm_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [BuiltForm_slug_key] UNIQUE NONCLUSTERED ([slug])
);

-- CreateTable
CREATE TABLE [dbo].[BuiltFormVersion] (
    [id] NVARCHAR(64) NOT NULL,
    [formId] NVARCHAR(64) NOT NULL,
    [version] INT NOT NULL,
    [schema] NVARCHAR(255) NOT NULL,
    [note] NVARCHAR(255),
    [publishedByName] NVARCHAR(255) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [BuiltFormVersion_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [BuiltFormVersion_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [BuiltFormVersion_formId_version_key] UNIQUE NONCLUSTERED ([formId],[version])
);

-- CreateTable
CREATE TABLE [dbo].[FormEntry] (
    [id] NVARCHAR(64) NOT NULL,
    [formId] NVARCHAR(64) NOT NULL,
    [formVersion] INT NOT NULL,
    [data] NVARCHAR(255) NOT NULL,
    [siteId] NVARCHAR(64),
    [source] NVARCHAR(255) NOT NULL CONSTRAINT [FormEntry_source_df] DEFAULT 'app',
    [status] NVARCHAR(255) NOT NULL CONSTRAINT [FormEntry_status_df] DEFAULT 'active',
    [occurredAt] DATETIME2 NOT NULL CONSTRAINT [FormEntry_occurredAt_df] DEFAULT CURRENT_TIMESTAMP,
    [tenantId] NVARCHAR(64),
    [overrideReason] NVARCHAR(max),
    [clientId] NVARCHAR(64),
    [createdById] NVARCHAR(64),
    [createdByName] NVARCHAR(255) NOT NULL,
    [ip] NVARCHAR(255),
    [userAgent] NVARCHAR(255),
    [voidedAt] DATETIME2,
    [voidedByName] NVARCHAR(255),
    [voidReason] NVARCHAR(max),
    [starred] BIT NOT NULL CONSTRAINT [FormEntry_starred_df] DEFAULT 0,
    [updatedByName] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormEntry_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [FormEntry_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[FormEntryNote] (
    [id] NVARCHAR(64) NOT NULL,
    [entryId] NVARCHAR(64) NOT NULL,
    [kind] NVARCHAR(255) NOT NULL CONSTRAINT [FormEntryNote_kind_df] DEFAULT 'note',
    [authorName] NVARCHAR(255) NOT NULL,
    [body] NVARCHAR(255) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormEntryNote_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [FormEntryNote_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[FormFile] (
    [id] NVARCHAR(64) NOT NULL,
    [formId] NVARCHAR(64) NOT NULL,
    [entryId] NVARCHAR(64),
    [fieldId] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [mime] NVARCHAR(255) NOT NULL,
    [size] INT NOT NULL,
    [data] VARBINARY(max) NOT NULL,
    [createdById] NVARCHAR(64),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormFile_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [FormFile_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[FormRecord] (
    [id] NVARCHAR(64) NOT NULL,
    [formId] NVARCHAR(64) NOT NULL,
    [collection] NVARCHAR(255) NOT NULL,
    [docId] NVARCHAR(64) NOT NULL,
    [data] NVARCHAR(255) NOT NULL,
    [updatedByName] NVARCHAR(255),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [FormRecord_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [FormRecord_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [FormRecord_formId_collection_docId_key] UNIQUE NONCLUSTERED ([formId],[collection],[docId])
);

-- CreateTable
CREATE TABLE [dbo].[User] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [email] NVARCHAR(255) NOT NULL,
    [entraObjectId] NVARCHAR(64),
    [identityProvider] NVARCHAR(255),
    [roleKey] NVARCHAR(255) NOT NULL CONSTRAINT [User_roleKey_df] DEFAULT 'site_staff',
    [status] NVARCHAR(255) NOT NULL CONSTRAINT [User_status_df] DEFAULT 'active',
    [title] NVARCHAR(255),
    [avatarColor] NVARCHAR(255),
    [defaultLandingPage] NVARCHAR(255) NOT NULL CONSTRAINT [User_defaultLandingPage_df] DEFAULT '/forms',
    [defaultSiteCode] NVARCHAR(255),
    [calendarEditor] BIT NOT NULL CONSTRAINT [User_calendarEditor_df] DEFAULT 0,
    [calendarSyncEverySite] BIT NOT NULL CONSTRAINT [User_calendarSyncEverySite_df] DEFAULT 0,
    [calendarSyncSetAt] DATETIME2,
    [calendarEmailTeams] BIT NOT NULL CONSTRAINT [User_calendarEmailTeams_df] DEFAULT 1,
    [calendarEmailOther] BIT NOT NULL CONSTRAINT [User_calendarEmailOther_df] DEFAULT 0,
    [calendarReminderMinutes] INT CONSTRAINT [User_calendarReminderMinutes_df] DEFAULT 15,
    [calendarAllDayFree] BIT NOT NULL CONSTRAINT [User_calendarAllDayFree_df] DEFAULT 1,
    [calendarSkipUncategorized] BIT NOT NULL CONSTRAINT [User_calendarSkipUncategorized_df] DEFAULT 0,
    [lastSignInAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [User_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [User_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [User_email_key] UNIQUE NONCLUSTERED ([email])
);

-- CreateTable
CREATE TABLE [dbo].[UserSite] (
    [userId] NVARCHAR(64) NOT NULL,
    [siteId] NVARCHAR(64) NOT NULL,
    CONSTRAINT [UserSite_pkey] PRIMARY KEY CLUSTERED ([userId],[siteId])
);

-- CreateTable
CREATE TABLE [dbo].[ApiKey] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [prefix] NVARCHAR(255) NOT NULL,
    [hash] NVARCHAR(64) NOT NULL,
    [scopes] NVARCHAR(255) NOT NULL,
    [siteId] NVARCHAR(64),
    [lastUsedAt] DATETIME2,
    [createdById] NVARCHAR(64),
    [revokedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ApiKey_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ApiKey_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ApiKey_hash_key] UNIQUE NONCLUSTERED ([hash])
);

-- CreateTable
CREATE TABLE [dbo].[Webhook] (
    [id] NVARCHAR(64) NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [url] NVARCHAR(max) NOT NULL,
    [secret] NVARCHAR(255) NOT NULL,
    [events] NVARCHAR(255) NOT NULL CONSTRAINT [Webhook_events_df] DEFAULT '*',
    [active] BIT NOT NULL CONSTRAINT [Webhook_active_df] DEFAULT 1,
    [lastDeliveryAt] DATETIME2,
    [lastStatus] INT,
    [lastError] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Webhook_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Webhook_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[WebhookDelivery] (
    [id] NVARCHAR(64) NOT NULL,
    [webhookId] NVARCHAR(64) NOT NULL,
    [event] NVARCHAR(255) NOT NULL,
    [statusCode] INT,
    [error] NVARCHAR(max),
    [durationMs] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [WebhookDelivery_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [WebhookDelivery_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Setting] (
    [key] NVARCHAR(255) NOT NULL,
    [value] NVARCHAR(255) NOT NULL,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Setting_pkey] PRIMARY KEY CLUSTERED ([key])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Site_entityName_idx] ON [dbo].[Site]([entityName]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Tenant_siteId_status_attentionClockAt_idx] ON [dbo].[Tenant]([siteId], [status], [attentionClockAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Tenant_siteId_status_unit_idx] ON [dbo].[Tenant]([siteId], [status], [unit]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Tenant_updatedAt_idx] ON [dbo].[Tenant]([updatedAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Tenant_lastName_firstName_idx] ON [dbo].[Tenant]([lastName], [firstName]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantActivity_source_externalRef_idx] ON [dbo].[TenantActivity]([source], [externalRef]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TenantActivity_tenantId_occurredAt_idx] ON [dbo].[TenantActivity]([tenantId], [occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditEvent_createdAt_idx] ON [dbo].[AuditEvent]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditEvent_siteId_createdAt_idx] ON [dbo].[AuditEvent]([siteId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditEvent_tenantId_createdAt_idx] ON [dbo].[AuditEvent]([tenantId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AttendanceEvent_siteId_occurredAt_idx] ON [dbo].[AttendanceEvent]([siteId], [occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AttendanceEntry_tenantId_idx] ON [dbo].[AttendanceEntry]([tenantId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [HotFoodEntry_siteId_occurredAt_idx] ON [dbo].[HotFoodEntry]([siteId], [occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [HotFoodEntry_tenantId_occurredAt_idx] ON [dbo].[HotFoodEntry]([tenantId], [occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [HotFoodEntry_occurredAt_idx] ON [dbo].[HotFoodEntry]([occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [HotFoodEntry_clientId_idx] ON [dbo].[HotFoodEntry]([clientId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [HotFoodEntryItem_entryId_idx] ON [dbo].[HotFoodEntryItem]([entryId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [HotFoodEntryItem_itemId_idx] ON [dbo].[HotFoodEntryItem]([itemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarCategoryMute_categoryId_idx] ON [dbo].[CalendarCategoryMute]([categoryId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarEvent_firstDate_idx] ON [dbo].[CalendarEvent]([firstDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarEvent_lastDate_idx] ON [dbo].[CalendarEvent]([lastDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarEventSite_siteId_idx] ON [dbo].[CalendarEventSite]([siteId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarFollow_siteId_idx] ON [dbo].[CalendarFollow]([siteId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CalendarException_startDate_idx] ON [dbo].[CalendarException]([startDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormLink_categoryId_sortOrder_idx] ON [dbo].[FormLink]([categoryId], [sortOrder]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormFavorite_formId_idx] ON [dbo].[FormFavorite]([formId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [BuiltForm_status_idx] ON [dbo].[BuiltForm]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_createdAt_idx] ON [dbo].[FormEntry]([formId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_status_idx] ON [dbo].[FormEntry]([formId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_occurredAt_idx] ON [dbo].[FormEntry]([formId], [occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_formId_tenantId_occurredAt_idx] ON [dbo].[FormEntry]([formId], [tenantId], [occurredAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_clientId_idx] ON [dbo].[FormEntry]([clientId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntry_siteId_idx] ON [dbo].[FormEntry]([siteId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormEntryNote_entryId_createdAt_idx] ON [dbo].[FormEntryNote]([entryId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormFile_entryId_idx] ON [dbo].[FormFile]([entryId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormFile_formId_createdAt_idx] ON [dbo].[FormFile]([formId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [FormRecord_formId_collection_idx] ON [dbo].[FormRecord]([formId], [collection]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [User_entraObjectId_idx] ON [dbo].[User]([entraObjectId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [WebhookDelivery_webhookId_createdAt_idx] ON [dbo].[WebhookDelivery]([webhookId], [createdAt]);

-- AddForeignKey
ALTER TABLE [dbo].[Tenant] ADD CONSTRAINT [Tenant_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[TenantActivity] ADD CONSTRAINT [TenantActivity_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AuditEvent] ADD CONSTRAINT [AuditEvent_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AttendanceEvent] ADD CONSTRAINT [AttendanceEvent_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AttendanceEntry] ADD CONSTRAINT [AttendanceEntry_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[AttendanceEvent]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AttendanceEntry] ADD CONSTRAINT [AttendanceEntry_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[HotFoodEntry] ADD CONSTRAINT [HotFoodEntry_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[HotFoodEntry] ADD CONSTRAINT [HotFoodEntry_tenantId_fkey] FOREIGN KEY ([tenantId]) REFERENCES [dbo].[Tenant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[HotFoodEntryItem] ADD CONSTRAINT [HotFoodEntryItem_entryId_fkey] FOREIGN KEY ([entryId]) REFERENCES [dbo].[HotFoodEntry]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[HotFoodEntryItem] ADD CONSTRAINT [HotFoodEntryItem_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[HotFoodItem]([id]) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarCategoryMute] ADD CONSTRAINT [CalendarCategoryMute_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarCategoryMute] ADD CONSTRAINT [CalendarCategoryMute_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[CalendarCategory]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarEvent] ADD CONSTRAINT [CalendarEvent_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[CalendarCategory]([id]) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarEventSite] ADD CONSTRAINT [CalendarEventSite_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarEventSite] ADD CONSTRAINT [CalendarEventSite_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarFollow] ADD CONSTRAINT [CalendarFollow_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarFollow] ADD CONSTRAINT [CalendarFollow_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarCopy] ADD CONSTRAINT [CalendarCopy_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CalendarException] ADD CONSTRAINT [CalendarException_eventId_fkey] FOREIGN KEY ([eventId]) REFERENCES [dbo].[CalendarEvent]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormLink] ADD CONSTRAINT [FormLink_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[FormCategory]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FormFavorite] ADD CONSTRAINT [FormFavorite_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormFavorite] ADD CONSTRAINT [FormFavorite_formId_fkey] FOREIGN KEY ([formId]) REFERENCES [dbo].[FormLink]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[BuiltFormVersion] ADD CONSTRAINT [BuiltFormVersion_formId_fkey] FOREIGN KEY ([formId]) REFERENCES [dbo].[BuiltForm]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormEntry] ADD CONSTRAINT [FormEntry_formId_fkey] FOREIGN KEY ([formId]) REFERENCES [dbo].[BuiltForm]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormEntryNote] ADD CONSTRAINT [FormEntryNote_entryId_fkey] FOREIGN KEY ([entryId]) REFERENCES [dbo].[FormEntry]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormFile] ADD CONSTRAINT [FormFile_formId_fkey] FOREIGN KEY ([formId]) REFERENCES [dbo].[BuiltForm]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[FormFile] ADD CONSTRAINT [FormFile_entryId_fkey] FOREIGN KEY ([entryId]) REFERENCES [dbo].[FormEntry]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[FormRecord] ADD CONSTRAINT [FormRecord_formId_fkey] FOREIGN KEY ([formId]) REFERENCES [dbo].[BuiltForm]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[UserSite] ADD CONSTRAINT [UserSite_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[UserSite] ADD CONSTRAINT [UserSite_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ApiKey] ADD CONSTRAINT [ApiKey_siteId_fkey] FOREIGN KEY ([siteId]) REFERENCES [dbo].[Site]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[WebhookDelivery] ADD CONSTRAINT [WebhookDelivery_webhookId_fkey] FOREIGN KEY ([webhookId]) REFERENCES [dbo].[Webhook]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

