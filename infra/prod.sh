#!/usr/bin/env bash
# Lantern Forms – production build, Oct 27 2026
#
# Run one section at a time in Cloud Shell:   bash prod.sh 1   ...   bash prod.sh 6
# Every section is safe to re-run (az create calls are idempotent on existing resources).
# Nothing secret is written by this script; section 4 prints the manual secret steps.
#
# Bakes in what dev taught us: SQL in Central US (East US 2 and East US refuse this
# subscription), ad-only-auth off (forms_app is a password user), App Insights value checked
# before it is written, vnet-route-all on, backend access-restricted to the frontend,
# diagnostics to Log Analytics, blob storage via managed identity.

set -euo pipefail

SUB="8572bc7a-71e9-4c54-bf3a-8a8222bc11f4"
LOC="eastus2"; SQL_LOC="centralus"
ENV="prod"; RG="rg-forms-$ENV"; RG_SHARED="rg-forms-shared"
VNET="vnet-forms-$ENV"; KV="kv-lcsforms-$ENV"; SQLSRV="sql-lcsforms-$ENV"; SQLDB="sqldb-forms-$ENV"
ASP="asp-forms-$ENV"; APPI="appi-forms-$ENV"; ST="stlcsforms$ENV"; ACR="acrlcsforms"; LOG="log-forms-shared"
T="app=lantern-forms owner=spena@lanterncommunity.org cost-center=IT"
TE="environment=production data-classification=phi"
TENANT="868d4efd-5d86-4442-96fe-8413bde027b0"; CLIENT_ID="7678724c-1bbf-499d-bf3f-a8ac4f7601b6"
BASE="https://lcsforms.lanterncommunity.org"; MAIL_FROM="forms@lanterncommunity.org"

az account set --subscription "$SUB"
[[ "$(az account show --query name -o tsv)" == "LCS-Forms" ]] || { echo "wrong subscription"; exit 1; }
az config set extension.use_dynamic_install=yes_without_prompt extension.dynamic_install_allow_preview=true -o none 2>/dev/null || true

# ---------------------------------------------------------------------------------------------
s1_network_monitoring_keyvault() {
  az network vnet create -n $VNET -g $RG -l $LOC --address-prefix 10.21.0.0/24 --tags $TE $T -o none
  az network vnet subnet create -n snet-app -g $RG --vnet-name $VNET --address-prefix 10.21.0.0/26 \
    --delegations Microsoft.Web/serverFarms -o none
  az network vnet subnet create -n snet-pe -g $RG --vnet-name $VNET --address-prefix 10.21.0.64/27 \
    --private-endpoint-network-policies Disabled -o none
  VNET_ID=$(az network vnet show -n $VNET -g $RG --query id -o tsv)
  for Z in privatelink.database.windows.net privatelink.vaultcore.azure.net privatelink.azurewebsites.net privatelink.blob.core.windows.net; do
    az network private-dns link vnet create -g $RG_SHARED -z $Z -n link-$ENV -v $VNET_ID -e false -o none 2>/dev/null || true
  done

  LOG_ID=$(az monitor log-analytics workspace show -n $LOG -g $RG_SHARED --query id -o tsv)
  az monitor app-insights component create --app $APPI -g $RG -l $LOC --workspace $LOG_ID --tags $TE $T -o none
  APPI_CONN=$(az monitor app-insights component show --app $APPI -g $RG --query connectionString -o tsv)
  [[ ${#APPI_CONN} -gt 50 ]] || { echo "App Insights connection string came back empty; stop and rerun section 1"; exit 1; }

  az keyvault create -n $KV -g $RG -l $LOC --enable-rbac-authorization true --enable-purge-protection true --tags $TE $T -o none
  KV_ID=$(az keyvault show -n $KV -g $RG --query id -o tsv)
  az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" --role "Key Vault Secrets Officer" --scope $KV_ID -o none
  az network private-endpoint create -n pe-$KV -g $RG --vnet-name $VNET --subnet snet-pe \
    --private-connection-resource-id $KV_ID --group-id vault --connection-name kv -o none
  az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-$KV -n kv-dns \
    --private-dns-zone "$(az network private-dns zone show -g $RG_SHARED -n privatelink.vaultcore.azure.net --query id -o tsv)" --zone-name vault -o none
  echo "section 1 done"
}

# ---------------------------------------------------------------------------------------------
s2_sql_storage() {
  LOG_ID=$(az monitor log-analytics workspace show -n $LOG -g $RG_SHARED --query id -o tsv)
  MY_OID=$(az ad signed-in-user show --query id -o tsv)
  az sql server create -n $SQLSRV -g $RG -l $SQL_LOC --enable-ad-only-auth \
    --external-admin-principal-type User --external-admin-name spena@lanterncommunity.org --external-admin-sid $MY_OID -o none
  az sql server update -n $SQLSRV -g $RG --set publicNetworkAccess=Disabled minimalTlsVersion=1.2 -o none
  az sql server ad-only-auth disable -n $SQLSRV -g $RG -o none      # forms_app is a password user; Prisma 5 cannot pass a token
  az sql db create -n $SQLDB -g $RG -s $SQLSRV --edition GeneralPurpose --family Gen5 --capacity 2 --compute-model Serverless \
    --auto-pause-delay -1 --backup-storage-redundancy Zone --tags $TE $T -o none
  SQL_ID=$(az sql server show -n $SQLSRV -g $RG --query id -o tsv)
  az network private-endpoint create -n pe-$SQLSRV -g $RG --vnet-name $VNET --subnet snet-pe \
    --private-connection-resource-id $SQL_ID --group-id sqlServer --connection-name sql -o none
  az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-$SQLSRV -n sql-dns \
    --private-dns-zone "$(az network private-dns zone show -g $RG_SHARED -n privatelink.database.windows.net --query id -o tsv)" --zone-name sql -o none
  az sql server audit-policy update -n $SQLSRV -g $RG --state Enabled --lats Enabled --lawri $LOG_ID -o none
  az sql server advanced-threat-protection-setting update -g $RG -n $SQLSRV --state Enabled -o none
  az sql db ltr-policy set -g $RG -s $SQLSRV -n $SQLDB --weekly-retention P12W --monthly-retention P12M --yearly-retention P7Y --week-of-year 1 -o none
  az sql db str-policy set -g $RG -s $SQLSRV -n $SQLDB --retention-days 35 -o none

  az storage account create -n $ST -g $RG -l $LOC --sku Standard_ZRS --kind StorageV2 --min-tls-version TLS1_2 \
    --allow-blob-public-access false --public-network-access Disabled --tags $TE $T -o none
  az storage account blob-service-properties update -n $ST -g $RG --enable-delete-retention true --delete-retention-days 30 --enable-versioning true -o none
  ST_ID=$(az storage account show -n $ST -g $RG --query id -o tsv)
  az network private-endpoint create -n pe-$ST -g $RG --vnet-name $VNET --subnet snet-pe \
    --private-connection-resource-id $ST_ID --group-id blob --connection-name blob -o none
  az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-$ST -n blob-dns \
    --private-dns-zone "$(az network private-dns zone show -g $RG_SHARED -n privatelink.blob.core.windows.net --query id -o tsv)" --zone-name blob -o none
  echo "section 2 done"
}

# ---------------------------------------------------------------------------------------------
s3_appservice() {
  ACR_ID=$(az acr show -n $ACR -g $RG_SHARED --query id -o tsv)
  KV_ID=$(az keyvault show -n $KV -g $RG --query id -o tsv)
  ST_ID=$(az storage account show -n $ST -g $RG --query id -o tsv)
  LOG_ID=$(az monitor log-analytics workspace show -n $LOG -g $RG_SHARED --query id -o tsv)
  APPI_CONN=$(az monitor app-insights component show --app $APPI -g $RG --query connectionString -o tsv)
  [[ ${#APPI_CONN} -gt 50 ]] || { echo "App Insights connection string empty; stop"; exit 1; }

  az appservice plan create -n $ASP -g $RG -l $LOC --is-linux --sku P1v3 --tags $TE $T -o none
  for APP in web api; do
    az webapp create -n app-forms-$APP-$ENV -g $RG --plan $ASP \
      --container-image-name $ACR.azurecr.io/lcs-forms-$APP:$ENV --https-only true --tags $TE $T -o none
    az webapp identity assign -n app-forms-$APP-$ENV -g $RG -o none
    APP_PID=$(az webapp identity show -n app-forms-$APP-$ENV -g $RG --query principalId -o tsv)
    az role assignment create --assignee-object-id $APP_PID --assignee-principal-type ServicePrincipal --role AcrPull --scope $ACR_ID -o none
    az webapp config set -n app-forms-$APP-$ENV -g $RG --generic-configurations '{"acrUseManagedIdentityCreds": true, "healthCheckPath": "/api/health"}' -o none
    az webapp vnet-integration add -n app-forms-$APP-$ENV -g $RG --vnet $VNET --subnet snet-app -o none
    az webapp config set -n app-forms-$APP-$ENV -g $RG --min-tls-version 1.2 --ftps-state Disabled --always-on true --vnet-route-all-enabled true -o none
    az webapp log config -n app-forms-$APP-$ENV -g $RG --docker-container-logging filesystem --application-logging filesystem -o none
    az monitor diagnostic-settings create -n to-law --resource "$(az webapp show -n app-forms-$APP-$ENV -g $RG --query id -o tsv)" --workspace $LOG_ID \
      --logs '[{"category":"AppServiceConsoleLogs","enabled":true},{"category":"AppServiceAppLogs","enabled":true},{"category":"AppServiceHTTPLogs","enabled":true},{"category":"AppServicePlatformLogs","enabled":true}]' -o none
  done
  API_PID=$(az webapp identity show -n app-forms-api-$ENV -g $RG --query principalId -o tsv)
  az role assignment create --assignee-object-id $API_PID --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope $KV_ID -o none
  az role assignment create --assignee-object-id $API_PID --assignee-principal-type ServicePrincipal --role "Storage Blob Data Contributor" --scope $ST_ID -o none

  KVS="https://$KV.vault.azure.net/secrets"
  az webapp config appsettings set -n app-forms-api-$ENV -g $RG --settings \
    WEBSITES_PORT=4200 PORT=4200 NODE_ENV=production DEV_AUTH=false DB_PUSH_ON_START=false SEED_DEMO_QUEUE=false RUN_MIGRATIONS=false \
    TRUST_PROXY=1 OUTLOOK_SYNC=true SUPER_ADMINS=spena@lanterncommunity.org \
    APP_BASE_URL=$BASE CORS_ORIGIN=$BASE MICROSOFT_REDIRECT_URI=$BASE/api/auth/microsoft/callback \
    SSO_ALLOWED_DOMAINS=lanterncommunity.org MICROSOFT_TENANT_ID=$TENANT MICROSOFT_CLIENT_ID=$CLIENT_ID MAIL_FROM=$MAIL_FROM \
    AZURE_STORAGE_ACCOUNT_URL=https://$ST.blob.core.windows.net AZURE_STORAGE_CONTAINER=form-files \
    APPLICATIONINSIGHTS_CONNECTION_STRING="$APPI_CONN" \
    JWT_SECRET="@Microsoft.KeyVault(SecretUri=$KVS/JWT-SECRET/)" \
    MICROSOFT_CLIENT_SECRET="@Microsoft.KeyVault(SecretUri=$KVS/MICROSOFT-CLIENT-SECRET/)" \
    TOKEN_ENCRYPTION_KEY="@Microsoft.KeyVault(SecretUri=$KVS/TOKEN-ENCRYPTION-KEY/)" \
    DATABASE_URL="@Microsoft.KeyVault(SecretUri=$KVS/DATABASE-URL/)" -o none
  az webapp config appsettings set -n app-forms-web-$ENV -g $RG --settings \
    WEBSITES_PORT=5200 NODE_ENV=production APPLICATIONINSIGHTS_CONNECTION_STRING="$APPI_CONN" -o none

  P=100
  for IP in $(az webapp show -n app-forms-web-$ENV -g $RG --query possibleOutboundIpAddresses -o tsv | tr ',' ' '); do
    az webapp config access-restriction add -n app-forms-api-$ENV -g $RG --rule-name web-$P --action Allow --ip-address $IP/32 --priority $P -o none
    P=$((P+1))
  done
  az webapp config access-restriction set -n app-forms-api-$ENV -g $RG --use-same-restrictions-for-scm-site true -o none
  echo "section 3 done"
}

# ---------------------------------------------------------------------------------------------
s4_secrets_instructions() {
  cat <<EOF
Section 4 is manual (two Key Vault openings and the SQL user). Paste these in order, in one shell:

  export PATH=\$HOME:\$PATH; which sqlcmd >/dev/null 2>&1 || (curl -sL https://github.com/microsoft/go-sqlcmd/releases/latest/download/sqlcmd-linux-amd64.tar.bz2 | tar xj -C ~ sqlcmd)
  KV=$KV; RG=$RG; SQLSRV=$SQLSRV; SQLDB=$SQLDB

  # Key Vault open for this step
  az keyvault update -n \$KV -g \$RG --public-network-access Enabled -o none; sleep 20
  az keyvault secret set --vault-name \$KV -n JWT-SECRET --value "\$(openssl rand -base64 48)" -o none
  az keyvault secret set --vault-name \$KV -n TOKEN-ENCRYPTION-KEY --value "\$(openssl rand -base64 32)" -o none
  SECRET=\$(az ad app credential reset --id $CLIENT_ID --display-name $KV --years 1 --append --query password -o tsv)
  az keyvault secret set --vault-name \$KV -n MICROSOFT-CLIENT-SECRET --value "\$SECRET" -o none; unset SECRET

  # SQL open for this step
  az sql server update -n \$SQLSRV -g \$RG --set publicNetworkAccess=Enabled -o none
  MYIP=\$(curl -s https://ifconfig.me)
  az sql server firewall-rule create -n temp-steven -g \$RG -s \$SQLSRV --start-ip-address \$MYIP --end-ip-address \$MYIP -o none
  PW=\$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
  sqlcmd -S \$SQLSRV.database.windows.net -d \$SQLDB --authentication-method ActiveDirectoryAzCli -Q "CREATE USER forms_app WITH PASSWORD = '\$PW'; ALTER ROLE db_datareader ADD MEMBER forms_app; ALTER ROLE db_datawriter ADD MEMBER forms_app; ALTER ROLE db_ddladmin ADD MEMBER forms_app;"
  sqlcmd -S \$SQLSRV.database.windows.net -d \$SQLDB -U forms_app -P "\$PW" -Q "SELECT SUSER_NAME();"      # must print forms_app before you continue
  az keyvault secret set --vault-name \$KV -n DATABASE-URL --value "sqlserver://\$SQLSRV.database.windows.net:1433;database=\$SQLDB;user=forms_app;password=\$PW;encrypt=true;trustServerCertificate=false" -o none
  unset PW

  # Close everything, force the app to re-read references
  az sql server firewall-rule delete -n temp-steven -g \$RG -s \$SQLSRV
  az sql server update -n \$SQLSRV -g \$RG --set publicNetworkAccess=Disabled -o none
  az keyvault update -n \$KV -g \$RG --public-network-access Disabled -o none
  az webapp config appsettings set -n app-forms-api-$ENV -g \$RG --settings KV_REFRESH=\$(date +%s) -o none
  az webapp restart -n app-forms-api-$ENV -g \$RG
EOF
}

# ---------------------------------------------------------------------------------------------
s5_domain() {
  # Needs two GoDaddy DNS records for lanterncommunity.org before this runs:
  #   CNAME  lcsforms        -> app-forms-web-prod.azurewebsites.net
  #   TXT    asuid.lcsforms  -> the verification ID printed below
  echo "Custom domain verification ID (TXT record asuid.lcsforms):"
  az webapp show -n app-forms-web-$ENV -g $RG --query customDomainVerificationId -o tsv
  read -r -p "Both DNS records created and propagated (dig lcsforms.lanterncommunity.org)? (y/N) " ok
  [[ "$ok" == "y" ]] || exit 0
  az webapp config hostname add --webapp-name app-forms-web-$ENV -g $RG --hostname lcsforms.lanterncommunity.org -o none
  az webapp config ssl create -n app-forms-web-$ENV -g $RG --hostname lcsforms.lanterncommunity.org -o none
  echo "section 5 done; the managed certificate can take 10-30 min. Check https://lcsforms.lanterncommunity.org/api/health"
}

# ---------------------------------------------------------------------------------------------
s6_guardrails() {
  SCOPE=/subscriptions/$SUB/resourceGroups/$RG
  az policy assignment create -n forms-prod-locations --policy e56962a6-4747-49cd-b67b-bf8b01975c4c --scope $SCOPE \
    --params '{"listOfAllowedLocations":{"value":["eastus2","centralus"]}}' -o none
  az policy assignment create -n forms-prod-sql-no-public --scope $SCOPE --policy 1b8ca024-1d5c-4dec-8995-b1a932b41780 -o none
  az policy assignment create -n forms-prod-kv-no-public  --scope $SCOPE --policy 405c5871-3e91-4644-8a63-58e19d68ff5b -o none
  az policy assignment create -n forms-prod-require-env-tag --scope $SCOPE --policy 871b6d14-10aa-478d-b590-94f262ecfa99 \
    --params '{"tagName":{"value":"environment"}}' -o none
  az security pricing create -n SqlServers --tier Standard -o none
  az security pricing create -n AppServices --tier Standard -o none
  az security pricing create -n KeyVaults --tier Standard -o none
  az security pricing create -n StorageAccounts --tier Standard -o none
  AG_ID=$(az monitor action-group show -n ag-forms-alerts -g $RG_SHARED --query id -o tsv)
  WEB_ID=$(az webapp show -n app-forms-web-$ENV -g $RG --query id -o tsv)
  # Alerts carry tags because the require-env-tag policy assigned above refuses untagged resources
  az monitor metrics alert create -n forms-prod-5xx -g $RG --scopes $WEB_ID \
    --condition "total Http5xx > 10" --window-size 5m --evaluation-frequency 1m --action $AG_ID --tags $TE $T -o none
  az monitor metrics alert create -n forms-prod-health -g $RG --scopes $WEB_ID \
    --condition "avg HealthCheckStatus < 100" --window-size 5m --evaluation-frequency 1m --action $AG_ID --tags $TE $T -o none
  az lock create -n forms-prod-no-delete -g $RG --lock-type CanNotDelete --notes "PHI system. Contact IT before removing." -o none
  az lock create -n forms-shared-no-delete -g $RG_SHARED --lock-type CanNotDelete --notes "Shared by dev and prod pipelines." -o none
  echo "section 6 done. Still manual: budget \$250/month on rg-forms-prod in the portal."
}

case "${1:-}" in
  1) s1_network_monitoring_keyvault ;;
  2) s2_sql_storage ;;
  3) s3_appservice ;;
  4) s4_secrets_instructions ;;
  5) s5_domain ;;
  6) s6_guardrails ;;
  *) echo "usage: bash prod.sh <1|2|3|4|5|6>"; exit 1 ;;
esac
