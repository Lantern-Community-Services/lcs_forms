#!/usr/bin/env bash
# Lantern Forms – Azure build script
#
# Records how every Azure resource for Lantern Forms was created, so an environment can be
# rebuilt the same way. Run phases individually:  ./build.sh <phase> <env>
#
#   ./build.sh shared            one-time: deploy identity, ACR, Log Analytics, private DNS zones
#   ./build.sh env dev           resource group, network, monitoring, Key Vault, SQL, App Service
#   ./build.sh env prod          same, with prod SKUs
#   ./build.sh lockdown prod     backend access restriction, lock, policies, budget
#
# Secrets are never written here. Steps that need a secret print what to do by hand.
# Subscription: LCS-Forms. Everything in East US 2 except SQL (East US; see infra/README.md).

set -euo pipefail

SUB="8572bc7a-71e9-4c54-bf3a-8a8222bc11f4"          # LCS-Forms
LOC="eastus2"
SQL_LOC="eastus"                                     # East US 2 refused SQL server creation for this subscription
RG_SHARED="rg-forms-shared"
ACR="acrlcsforms"
LOG="log-forms-shared"
DEPLOY_ID="id-forms-deploy"
REPO="Lantern-Community-Services/lcs_forms"
OWNER_TAG="owner=spena@lanterncommunity.org"
TAGS_COMMON="app=lantern-forms $OWNER_TAG cost-center=IT"

PHASE="${1:-}"; ENV="${2:-}"

require_sub() {
  az account set --subscription "$SUB"
  local name; name=$(az account show --query name -o tsv)
  [[ "$name" == "LCS-Forms" ]] || { echo "Wrong subscription: $name"; exit 1; }
}

env_vars() {
  [[ "$ENV" == "dev" || "$ENV" == "prod" ]] || { echo "env must be dev or prod"; exit 1; }
  RG="rg-forms-$ENV"
  VNET="vnet-forms-$ENV"
  KV="kv-lcsforms-$ENV"
  SQLSRV="sql-lcsforms-$ENV"
  SQLDB="sqldb-forms-$ENV"
  ASP="asp-forms-$ENV"
  APPI="appi-forms-$ENV"
  if [[ "$ENV" == "dev" ]]; then
    TE="environment=development data-classification=internal"
    CIDR="10.20.0.0/24"; SNET_APP="10.20.0.0/26"; SNET_PE="10.20.0.64/27"
    ASP_SKU="B2"; DB_ARGS="--edition Basic --backup-storage-redundancy Local"
    MAIL_FROM="forms-dev@lanterncommunity.org"
    CLIENT_ID="af86fc4c-3427-498f-ab39-258b4aff1ab7"
    BASE="https://app-forms-web-dev.azurewebsites.net"
    BUDGET=80
  else
    TE="environment=production data-classification=phi"
    CIDR="10.21.0.0/24"; SNET_APP="10.21.0.0/26"; SNET_PE="10.21.0.64/27"
    ASP_SKU="P1v3"; DB_ARGS="--edition GeneralPurpose --family Gen5 --capacity 2 --compute-model Serverless --zone-redundant true --backup-storage-redundancy Zone"
    MAIL_FROM="forms@lanterncommunity.org"
    CLIENT_ID="7678724c-1bbf-499d-bf3f-a8ac4f7601b6"
    BASE="https://lcsforms.lanterncommunity.org"
    BUDGET=250
  fi
  TENANT="868d4efd-5d86-4442-96fe-8413bde027b0"
}

# ---------------------------------------------------------------------------------------------
phase_shared() {
  require_sub
  az group create -n $RG_SHARED -l $LOC --tags environment=shared $TAGS_COMMON data-classification=internal -o none

  # Deploy identity for GitHub Actions (OIDC, no secrets)
  az identity create -n $DEPLOY_ID -g $RG_SHARED -l $LOC -o none
  for E in dev prod; do
    az identity federated-credential create --identity-name $DEPLOY_ID -g $RG_SHARED \
      -n "gh-lcs_forms-$E" --issuer https://token.actions.githubusercontent.com \
      --subject "repo:$REPO:environment:$E" --audiences api://AzureADTokenExchange -o none || true
  done
  ID_PRINCIPAL=$(az identity show -n $DEPLOY_ID -g $RG_SHARED --query principalId -o tsv)

  # Registry (admin user off; apps pull with managed identity, pipeline pushes with id-forms-deploy)
  az acr create -n $ACR -g $RG_SHARED -l $LOC --sku Basic --admin-enabled false \
    --tags environment=shared $TAGS_COMMON data-classification=internal -o none
  az role assignment create --assignee-object-id $ID_PRINCIPAL --assignee-principal-type ServicePrincipal \
    --role AcrPush --scope "$(az acr show -n $ACR -g $RG_SHARED --query id -o tsv)" -o none

  # Logs
  az monitor log-analytics workspace create -n $LOG -g $RG_SHARED -l $LOC --retention-time 90 \
    --tags environment=shared $TAGS_COMMON -o none

  # Private DNS zones, linked to each env VNet in phase_env
  for Z in privatelink.database.windows.net privatelink.vaultcore.azure.net privatelink.azurewebsites.net; do
    az network private-dns zone create -g $RG_SHARED -n $Z --tags environment=shared $TAGS_COMMON -o none
  done
  echo "AZURE_CLIENT_ID for GitHub: $(az identity show -n $DEPLOY_ID -g $RG_SHARED --query clientId -o tsv)"
}

# ---------------------------------------------------------------------------------------------
phase_env() {
  require_sub; env_vars
  ID_PRINCIPAL=$(az identity show -n $DEPLOY_ID -g $RG_SHARED --query principalId -o tsv)
  LOG_ID=$(az monitor log-analytics workspace show -n $LOG -g $RG_SHARED --query id -o tsv)
  ACR_ID=$(az acr show -n $ACR -g $RG_SHARED --query id -o tsv)
  MY_OID=$(az ad signed-in-user show --query id -o tsv)

  # Resource group
  az group create -n $RG -l $LOC --tags $TE $TAGS_COMMON -o none
  az role assignment create --assignee-object-id $ID_PRINCIPAL --assignee-principal-type ServicePrincipal \
    --role "Website Contributor" --scope /subscriptions/$SUB/resourceGroups/$RG -o none

  # Network
  az network vnet create -n $VNET -g $RG -l $LOC --address-prefix $CIDR --tags $TE $TAGS_COMMON -o none
  az network vnet subnet create -n snet-app -g $RG --vnet-name $VNET --address-prefix $SNET_APP \
    --delegations Microsoft.Web/serverFarms -o none
  az network vnet subnet create -n snet-pe -g $RG --vnet-name $VNET --address-prefix $SNET_PE \
    --private-endpoint-network-policies Disabled -o none
  VNET_ID=$(az network vnet show -n $VNET -g $RG --query id -o tsv)
  for Z in privatelink.database.windows.net privatelink.vaultcore.azure.net privatelink.azurewebsites.net; do
    az network private-dns link vnet create -g $RG_SHARED -z $Z -n link-$ENV -v $VNET_ID -e false -o none
  done

  # Monitoring
  az monitor app-insights component create --app $APPI -g $RG -l $LOC --workspace $LOG_ID --tags $TE $TAGS_COMMON -o none
  APPI_CONN=$(az monitor app-insights component show --app $APPI -g $RG --query connectionString -o tsv)

  # Key Vault (RBAC, purge protection, private endpoint). Public access stays on until secrets are loaded.
  az keyvault create -n $KV -g $RG -l $LOC --enable-rbac-authorization true --enable-purge-protection true \
    --tags $TE $TAGS_COMMON -o none
  KV_ID=$(az keyvault show -n $KV -g $RG --query id -o tsv)
  az role assignment create --assignee $MY_OID --role "Key Vault Secrets Officer" --scope $KV_ID -o none
  az network private-endpoint create -n pe-$KV -g $RG --vnet-name $VNET --subnet snet-pe \
    --private-connection-resource-id $KV_ID --group-id vault --connection-name kv -o none
  az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-$KV -n kv-dns \
    --private-dns-zone "$(az network private-dns zone show -g $RG_SHARED -n privatelink.vaultcore.azure.net --query id -o tsv)" \
    --zone-name vault -o none

  # SQL – Entra-only server in SQL_LOC, private endpoint in the env VNet, auditing to Log Analytics
  az sql server create -n $SQLSRV -g $RG -l $SQL_LOC --enable-ad-only-auth \
    --external-admin-principal-type User --external-admin-name spena@lanterncommunity.org --external-admin-sid $MY_OID -o none
  az sql server update -n $SQLSRV -g $RG --set publicNetworkAccess=Disabled minimalTlsVersion=1.2 -o none
  az sql db create -n $SQLDB -g $RG -s $SQLSRV $DB_ARGS --tags $TE $TAGS_COMMON -o none
  SQL_ID=$(az sql server show -n $SQLSRV -g $RG --query id -o tsv)
  az network private-endpoint create -n pe-$SQLSRV -g $RG --vnet-name $VNET --subnet snet-pe \
    --private-connection-resource-id $SQL_ID --group-id sqlServer --connection-name sql -o none
  az network private-endpoint dns-zone-group create -g $RG --endpoint-name pe-$SQLSRV -n sql-dns \
    --private-dns-zone "$(az network private-dns zone show -g $RG_SHARED -n privatelink.database.windows.net --query id -o tsv)" \
    --zone-name sql -o none
  az sql server audit-policy update -n $SQLSRV -g $RG --state Enabled --lats Enabled --lawri $LOG_ID -o none
  az sql db threat-policy update -n $SQLDB -g $RG -s $SQLSRV --state Enabled -o none

  # App Service plan + two web apps
  az appservice plan create -n $ASP -g $RG -l $LOC --is-linux --sku $ASP_SKU --tags $TE $TAGS_COMMON -o none
  for APP in web api; do
    az webapp create -n app-forms-$APP-$ENV -g $RG --plan $ASP \
      --container-image-name $ACR.azurecr.io/lcs-forms-$APP:$ENV --https-only true --tags $TE $TAGS_COMMON -o none
    az webapp identity assign -n app-forms-$APP-$ENV -g $RG -o none
    APP_PID=$(az webapp identity show -n app-forms-$APP-$ENV -g $RG --query principalId -o tsv)
    az role assignment create --assignee-object-id $APP_PID --assignee-principal-type ServicePrincipal --role AcrPull --scope $ACR_ID -o none
    az webapp config set -n app-forms-$APP-$ENV -g $RG --generic-configurations '{"acrUseManagedIdentityCreds": true, "healthCheckPath": "/api/health"}' -o none
    az webapp vnet-integration add -n app-forms-$APP-$ENV -g $RG --vnet $VNET --subnet snet-app -o none
    az webapp config set -n app-forms-$APP-$ENV -g $RG --min-tls-version 1.2 --ftps-state Disabled --always-on true -o none
    az webapp log config -n app-forms-$APP-$ENV -g $RG --docker-container-logging filesystem --application-logging filesystem -o none
  done
  API_PID=$(az webapp identity show -n app-forms-api-$ENV -g $RG --query principalId -o tsv)
  az role assignment create --assignee-object-id $API_PID --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope $KV_ID -o none

  # App settings – secrets are Key Vault references, resolved by the platform
  KVS="https://$KV.vault.azure.net/secrets"
  az webapp config appsettings set -n app-forms-api-$ENV -g $RG --settings \
    WEBSITES_PORT=4200 PORT=4200 NODE_ENV=production DEV_AUTH=false DB_PUSH_ON_START=false SEED_DEMO_QUEUE=false RUN_MIGRATIONS=false \
    APP_BASE_URL=$BASE CORS_ORIGIN=$BASE MICROSOFT_REDIRECT_URI=$BASE/api/auth/microsoft/callback \
    SSO_ALLOWED_DOMAINS=lanterncommunity.org MICROSOFT_TENANT_ID=$TENANT MICROSOFT_CLIENT_ID=$CLIENT_ID MAIL_FROM=$MAIL_FROM \
    APPLICATIONINSIGHTS_CONNECTION_STRING="$APPI_CONN" \
    JWT_SECRET="@Microsoft.KeyVault(SecretUri=$KVS/JWT-SECRET/)" \
    MICROSOFT_CLIENT_SECRET="@Microsoft.KeyVault(SecretUri=$KVS/MICROSOFT-CLIENT-SECRET/)" \
    DATABASE_URL="@Microsoft.KeyVault(SecretUri=$KVS/DATABASE-URL/)" -o none
  az webapp config appsettings set -n app-forms-web-$ENV -g $RG --settings \
    WEBSITES_PORT=5200 NODE_ENV=production APPLICATIONINSIGHTS_CONNECTION_STRING="$APPI_CONN" -o none

  # Budget
  az consumption budget create --budget-name forms-$ENV-monthly --amount $BUDGET --time-grain Monthly \
    --start-date "$(date +%Y-%m-01)" --end-date 2028-12-31 --resource-group $RG --category Cost -o none || true

  cat <<EOF

Manual steps for $ENV (secrets never go in this script):
  1. az keyvault secret set --vault-name $KV -n JWT-SECRET --value "\$(openssl rand -base64 48)"
  2. New client secret on the Entra app $CLIENT_ID (12 months) -> az keyvault secret set --vault-name $KV -n MICROSOFT-CLIENT-SECRET --value ...
  3. Temporarily allow your IP on $SQLSRV, connect as yourself (Entra MFA) to $SQLDB and run infra/sql/forms_app.sql with a generated password
  4. az keyvault secret set --vault-name $KV -n DATABASE-URL --value "sqlserver://$SQLSRV.database.windows.net:1433;database=$SQLDB;user=forms_app;password=...;encrypt=true;trustServerCertificate=false"
  5. Remove the temporary firewall rule; az sql server update -n $SQLSRV -g $RG --set publicNetworkAccess=Disabled
  6. az keyvault update -n $KV -g $RG --public-network-access Disabled
EOF
}

# ---------------------------------------------------------------------------------------------
phase_lockdown() {
  require_sub; env_vars
  # Backend answers only the frontend (dev: IP allow-list; prod: replace with a private endpoint per playbook 6.1)
  P=100
  for IP in $(az webapp show -n app-forms-web-$ENV -g $RG --query possibleOutboundIpAddresses -o tsv | tr ',' ' '); do
    az webapp config access-restriction add -n app-forms-api-$ENV -g $RG --rule-name web-$P --action Allow --ip-address $IP/32 --priority $P -o none
    P=$((P+1))
  done
  az webapp config access-restriction set -n app-forms-api-$ENV -g $RG --use-same-restrictions-for-scm-site true -o none

  SCOPE=/subscriptions/$SUB/resourceGroups/$RG
  az policy assignment create -n forms-$ENV-locations --policy e56962a6-4747-49cd-b67b-bf8b01975c4c --scope $SCOPE \
    --params '{"listOfAllowedLocations":{"value":["eastus2","eastus"]}}' -o none
  az policy assignment create -n forms-$ENV-sql-no-public --scope $SCOPE --policy 1b8ca024-1d5c-4dec-8995-b1a932b41780 -o none
  az policy assignment create -n forms-$ENV-kv-no-public  --scope $SCOPE --policy 405c5871-3e91-4644-8a63-58e19d68ff5b -o none
  az policy assignment create -n forms-$ENV-require-env-tag --scope $SCOPE --policy 871b6d14-10aa-478d-b590-94f262ecfa99 \
    --params '{"tagName":{"value":"environment"}}' -o none

  if [[ "$ENV" == "prod" ]]; then
    az lock create -n forms-prod-no-delete -g $RG --lock-type CanNotDelete --notes "PHI system. Contact IT before removing." -o none
    az sql db ltr-policy set -g $RG -s $SQLSRV -n $SQLDB --weekly-retention P12W --monthly-retention P12M --yearly-retention P7Y --week-of-year 1 -o none
    az sql db str-policy set -g $RG -s $SQLSRV -n $SQLDB --retention-days 35 -o none
  fi
}

case "$PHASE" in
  shared)   phase_shared ;;
  env)      phase_env ;;
  lockdown) phase_lockdown ;;
  *) echo "usage: $0 shared | env <dev|prod> | lockdown <dev|prod>"; exit 1 ;;
esac
