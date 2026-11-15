# Kapunyitó segédprogram: a Hikvision SDK csak x86-64 Linuxon fut, ezért konténerben él.
# Építés a projekt gyökeréből:  docker build --platform linux/amd64 -t kamerak-door door
FROM debian:bookworm-slim
ARG SDK_DIR=EN-HCNetSDKV6.1.11.40_build20260922_linux64
COPY sdk/${SDK_DIR}/incEn/ /src/inc/
COPY sdk/${SDK_DIR}/lib/ /opt/hik/lib/
COPY door-open.cpp /src/
ENV LD_LIBRARY_PATH=/opt/hik/lib:/opt/hik/lib/HCNetSDKCom
# A fordító csak a build idejére kell, utána eltávolítjuk.
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ \
 && g++ -O1 -w -o /usr/local/bin/door-open /src/door-open.cpp -I/src/inc -L/opt/hik/lib -lhcnetsdk -Wl,-rpath,/opt/hik/lib \
 && apt-get purge -y --auto-remove g++ \
 && rm -rf /var/lib/apt/lists/* /src
ENTRYPOINT ["door-open"]
