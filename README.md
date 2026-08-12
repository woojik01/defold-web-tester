# Defold Web Tester

Defold 프로젝트 ZIP → 자동 분석 → Bob HTML5(wasm-web) 빌드 → 즉시 게임 미리보기를 위한 모바일 대응 웹 앱입니다.

## 요구 사항

Docker Desktop만 있으면 됩니다.

Defold 1.12.x 계열을 기준으로 Bob 1.12.4 stable을 이미지에 포함합니다.
현재 Defold 문서의 Bob은 OpenJDK 25를 요구하며 HTML5 대상은 `wasm-web`입니다.

## 실행

Windows PowerShell:

```powershell
docker compose up --build
```

그 다음 브라우저에서:

http://localhost:3000

을 엽니다.

## 사용

1. Defold 프로젝트를 ZIP으로 압축합니다.
2. PC 또는 휴대폰에서 ZIP을 선택합니다.
3. `미리보기 실행`을 누릅니다.
4. 서버가 `game.project`를 자동으로 찾고 프로젝트를 분석합니다.
5. Bob으로 `wasm-web` HTML5 bundle을 생성합니다.
6. 완료되면 게임이 바로 미리보기 영역에 실행됩니다.
7. 모바일에서는 세로/가로 화면과 전체 화면 버튼을 사용할 수 있습니다.

ZIP은 다음과 같이 프로젝트 폴더를 한 번 감싸도 됩니다.

```text
my-game.zip
└─ my-game/
   ├─ game.project
   ├─ main/
   ├─ assets/
   └─ ...
```

또는:

```text
my-game.zip
├─ game.project
├─ main/
└─ ...
```

## 중요한 제한

이 서버는 업로드된 프로젝트를 실제로 빌드합니다. 따라서 신뢰하지 않는 ZIP을 인터넷에 공개된 서버에서 빌드하는 용도로 사용하지 마세요. 특히 Native Extension이나 외부 의존성이 포함된 프로젝트는 빌드 과정에서 추가 작업을 수행할 수 있습니다.

현재 설정은 개인 PC에서 테스트하는 용도입니다.

## Bob 버전 변경

`docker-compose.yml`의:

```yaml
BOB_VERSION: "1.12.4"
```

를 변경하면 Docker 이미지 빌드 시 다른 Defold release의 `bob.jar`를 사용할 수 있습니다.

Defold 1.13.x 프로젝트를 주로 사용할 경우 Bob 1.13.x release로 맞추는 것이 좋습니다. 1.13.0에서는 오래된 `js-web` 대상이 제거되고 `wasm-web`이 기본 웹 대상입니다.

## 구조

```text
defold-web-tester/
├─ public/
│  └─ index.html
├─ server.js
├─ package.json
├─ Dockerfile
├─ docker-compose.yml
├─ .dockerignore
└─ README.md
```
