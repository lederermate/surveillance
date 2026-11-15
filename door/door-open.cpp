// Kapunyitó segédprogram a Hikvision kaputelefonhoz (HCNetSDK, 8000-es port).
//
// Használat: door-open selftest | check | open | serve
//   selftest  csak betölti az SDK-t (belépés nélkül)
//   check     belép a kaputelefonra, majd kilép (jelszó ellenőrzése)
//   open      belép és kinyitja a kaput
//   serve     készenlétben marad, és a szabványos bemenetről soronként fogad
//             parancsokat (ping | check | open); így az SDK lassú betöltése
//             csak egyszer történik meg
//
// A belépési adatok környezeti változókból jönnek: INTERCOM_HOST, INTERCOM_USER,
// INTERCOM_PASSWORD, opcionálisan INTERCOM_SDK_PORT (alapból 8000).
// Minden parancsra egyetlen JSON sor a válasz.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "HCNetSDK.h"

static const char *SDK_DIR = "/opt/hik/lib";

static void say(const char *json) {
  printf("%s\n", json);
  fflush(stdout);
}

static void sayError(const char *step) {
  char buf[128];
  snprintf(buf, sizeof(buf), "{\"ok\":false,\"step\":\"%s\",\"code\":%u}", step, (unsigned)NET_DVR_GetLastError());
  say(buf);
}

// Belép, opcionálisan nyit, kilép. Visszatérés: 0 = siker, 2 = belépési hiba, 3 = nyitási hiba, 64 = hiányzó beállítás.
static int act(bool open) {
  const char *host = getenv("INTERCOM_HOST");
  const char *user = getenv("INTERCOM_USER");
  const char *pass = getenv("INTERCOM_PASSWORD");
  const char *portStr = getenv("INTERCOM_SDK_PORT");
  if (!host || !*host || !user || !*user || !pass) {
    say("{\"ok\":false,\"step\":\"config\",\"code\":0}");
    return 64;
  }

  NET_DVR_USER_LOGIN_INFO login;
  NET_DVR_DEVICEINFO_V40 device;
  memset(&login, 0, sizeof(login));
  memset(&device, 0, sizeof(device));
  snprintf(login.sDeviceAddress, sizeof(login.sDeviceAddress), "%s", host);
  snprintf(login.sUserName, sizeof(login.sUserName), "%s", user);
  snprintf(login.sPassword, sizeof(login.sPassword), "%s", pass);
  login.wPort = (WORD)(portStr && *portStr ? atoi(portStr) : 8000);
  login.bUseAsynLogin = 0;

  LONG uid = NET_DVR_Login_V40(&login, &device);
  if (uid < 0) {
    sayError("login");
    return 2;
  }

  int rc = 0;
  if (open) {
    NET_DVR_CONTROL_GATEWAY gw;
    memset(&gw, 0, sizeof(gw));
    gw.dwSize = sizeof(gw);
    gw.dwGatewayIndex = 1;  // első zár
    gw.byCommand = 1;       // nyitás
    gw.byLockType = 0;      // hagyományos zár
    gw.wLockID = 0;         // a kültéri egység zárja
    snprintf((char *)gw.byControlSrc, sizeof(gw.byControlSrc), "webapp");
    gw.byControlType = 1;
    if (!NET_DVR_RemoteControl(uid, NET_DVR_REMOTECONTROL_GATEWAY, &gw, sizeof(gw))) {
      sayError("open");
      rc = 3;
    }
  }
  NET_DVR_Logout(uid);
  if (rc == 0) say("{\"ok\":true}");
  return rc;
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "";
  bool selftest = strcmp(mode, "selftest") == 0;
  bool check = strcmp(mode, "check") == 0;
  bool open = strcmp(mode, "open") == 0;
  bool serve = strcmp(mode, "serve") == 0;
  if (!selftest && !check && !open && !serve) {
    fprintf(stderr, "Használat: door-open selftest|check|open|serve\n");
    return 64;
  }

  NET_DVR_LOCAL_SDK_PATH sdkPath;
  memset(&sdkPath, 0, sizeof(sdkPath));
  snprintf(sdkPath.sPath, sizeof(sdkPath.sPath), "%s", SDK_DIR);
  NET_DVR_SetSDKInitCfg(NET_SDK_INIT_CFG_SDK_PATH, &sdkPath);
  char crypto[256], ssl[256];
  snprintf(crypto, sizeof(crypto), "%s/libcrypto.so.3", SDK_DIR);
  snprintf(ssl, sizeof(ssl), "%s/libssl.so.3", SDK_DIR);
  NET_DVR_SetSDKInitCfg(NET_SDK_INIT_CFG_LIBEAY_PATH, crypto);
  NET_DVR_SetSDKInitCfg(NET_SDK_INIT_CFG_SSLEAY_PATH, ssl);

  if (!NET_DVR_Init()) {
    sayError("init");
    return 3;
  }
  // Egyetlen kísérlet: hibás jelszónál nem próbálkozunk újra, nehogy az eszköz letiltson.
  NET_DVR_SetConnectTime(4000, 1);

  int rc = 0;
  if (selftest) {
    DWORD v = NET_DVR_GetSDKBuildVersion();
    char buf[96];
    snprintf(buf, sizeof(buf), "{\"ok\":true,\"sdk\":\"%u.%u.%u.%u\"}", (unsigned)((v >> 24) & 0xff),
             (unsigned)((v >> 16) & 0xff), (unsigned)((v >> 8) & 0xff), (unsigned)(v & 0xff));
    say(buf);
  } else if (serve) {
    say("{\"ready\":true}");
    char line[64];
    while (fgets(line, sizeof(line), stdin)) {
      line[strcspn(line, "\r\n")] = 0;
      if (strcmp(line, "ping") == 0) say("{\"ok\":true,\"pong\":true}");
      else if (strcmp(line, "check") == 0) act(false);
      else if (strcmp(line, "open") == 0) act(true);
      else if (strcmp(line, "quit") == 0) break;
      else say("{\"ok\":false,\"step\":\"command\",\"code\":0}");
    }
  } else {
    rc = act(open);
  }

  NET_DVR_Cleanup();
  return rc;
}
