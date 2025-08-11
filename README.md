# ThemePresetManager

> [!WARNING]
> 이 확장 프로그램은 아직 개발중입니다. 불안정한 부분이나 동작을 보증하지 않는 부분이 있을 수 있습니다.

SillyTavern용 테마 프리셋 관리자 확장입니다. 캐릭터별, 채팅별로 테마와 사용자 설정을 자동저장하고 복원하는 시스템을 제공합니다.

## 🌟 주요 기능

### 🎨 테마 및 설정 관리
- **캐릭터별, 채팅별 테마 저장**: 각 캐릭터와 채팅마다 개별적으로 테마와 설정을 저장 가능
- **수동 저장/로드**: 안전한 테마 관리 시스템
- **자동 테마 적용**: 채팅/캐릭터 전환 시 자동으로 저장된 테마 적용 (선택사항)
- **상세설정 패널**: 저장할 설정을 세밀하게 선택 가능

### 💾 스마트 저장 시스템
- **채팅별 테마**: 현재 채팅에만 적용되는 테마 설정
- **캐릭터별 테마**: 현재 캐릭터의 모든 채팅에 적용되는 테마 설정
- **자동 저장 슬롯**: 테마 변경 직전 설정을 자동으로 백업
- **슬래시 커맨드 지원**: `/themeSaveChat`, `/themeSaveChar` 명령어로 빠르게 저장 (강제 덮어쓰기 옵션 포함)

### 🔄 자동 복원 시스템
- **우선순위 적용**: 채팅 테마 → 캐릭터 테마 → UI 기본 설정 순서로 적용
- **스마트 자동저장**: 사용자 경험에 따른 지능적인 저장 방식

### ⚙️ 고급 관리 기능
- **상세설정 패널**: 테마, UI, 메시지, 기타 설정을 카테고리별로 선택
- **기본 옵션 관리**: 자주 사용하는 설정들을 기본값으로 설정
- **설정 내보내기/가져오기**: 백업 및 복구 기능 (전체/개별)
- **개별/전체 삭제**: 필요한 설정만 선택적으로 삭제

## 🚀 설치 방법

1. 확장프로그램 설치(Extensions > Install Extension)에서 `https://github.com/nonameaaai/ThemePresetManager` 주소를 입력합니다.
2. SillyTavern을 재시작합니다.
3. 설정(UI Settings) 메뉴의 오른쪽 열에서 "테마 프리셋 관리자" 확장을 찾아 사용합니다.

## 📖 사용법

### 기본 설정
1. **자동 테마 적용**: "자동 테마 적용" 체크박스를 활성화하여 채팅/캐릭터 전환 시 테마 자동 복원 기능을 사용하세요 (권장).
2. **기본 옵션 설정**: "상세설정" 패널에서 자주 사용하는 설정들을 체크한 뒤, "현재 선택을 기본으로 저장" 버튼을 눌러 자신만의 저장 기본값을 만드세요 (권장).

### 수동 저장
- **채팅에 저장**: "채팅에 저장" 버튼으로 현재 채팅에만 적용되는 테마를 저장합니다.
- **캐릭터에 저장**: "캐릭터에 저장" 버튼으로 현재 캐릭터의 모든 채팅에 적용되는 테마를 저장합니다.
- **저장 방식**:
  - 상세설정 패널이 열려있을 때: 패널에서 **선택된 설정만** 저장됩니다.
  - 상세설정 패널이 닫혀있을 때: **미리 지정한 기본 옵션만** 저장됩니다.

### 슬래시 커맨드 (v1.1.0+)
- `/themeSaveChat`: 현재 테마를 채팅에 저장합니다. (확인창 표시)
- `/themeSaveChat force=true`: 확인창 없이 강제로 채팅에 덮어쓰기합니다.
- `/themeSaveChar`: 현재 테마를 캐릭터에 저장합니다. (확인창 표시)
- `/themeSaveChar force=true`: 확인창 없이 강제로 캐릭터에 덮어쓰기합니다.

### 수동 로드
- **채팅에서 로드 / 캐릭터에서 로드**: 각 버튼으로 저장된 테마를 수동으로 불러옵니다.
- **자동 저장 슬롯에서 복원**: 테마가 변경되기 직전의 상태로 UI 설정을 되돌립니다.

### 백업 및 복구
- **전체 설정**: 모든 캐릭터/채팅 테마와 확장 설정을 하나의 파일로 내보내거나 가져옵니다.
- **특정 설정**: 현재 선택된 캐릭터 또는 채팅의 테마만 개별적으로 내보내거나 가져올 수 있어, 다른 사람과 테마를 공유하기에 용이합니다.

## 🐛 알려진 문제 및 향후 계획

- **부분적인 현지화**: 현재 UI의 정적 텍스트는 현지화를 지원하지만, `toastr` 알림이나 `confirm` 확인창 등 JavaScript에서 동적으로 생성되는 일부 문자열은 아직 영어로 표시됩니다.
- **향후 계획**: 다음 버전에서 모든 동적 문자열에 대한 완벽한 현지화(I18n) 지원을 추가할 예정입니다.

## 📝 변경 로그

### **버전 1.1.0** (현재)
- **기능**: 슬래시 커맨드 추가 (`/themeSaveChat`, `/themeSaveChar`, `force` 옵션 지원).
- **개선**: UI 현지화(I18n) 시스템 도입. 이제 영어와 한국어 UI를 기본으로 지원합니다.
- **개선**: HTML 구조를 리팩토링하여 SillyTavern 표준 방식에 맞게 개선.
- **문서**: README 파일에 영문 설명서 추가 및 구조 개선.

### 버전 1.0.0
- 기본 테마 저장/로드 기능.
- 캐릭터별, 채팅별 테마 관리.
- 자동 테마 적용 및 자동 저장 슬롯 기능.
- 설정 내보내기/가져오기 및 상세설정 패널.

## 🤝 기여하기

버그 리포트나 기능 제안은 GitHub Issues를 통해 제출해주세요.

## 📄 라이선스

AGPL-3.0

---
---

# ThemePresetManager (English)

> [!WARNING]
> This extension is still under development. There may be unstable parts or parts that are not guaranteed to work.

A theme preset manager extension for SillyTavern. It provides a system to automatically save and restore themes and user settings for each character and chat.

## 🌟 Key Features

### 🎨 Theme and Settings Management
- **Per-Character, Per-Chat Theme Saving**: Save themes and settings individually for each character and chat.
- **Manual Save/Load**: A safe theme management system.
- **Auto-Apply Theme**: Automatically apply saved themes when switching chats/characters (optional).
- **Advanced Settings Panel**: Finely select which settings to save.

### 💾 Smart Saving System
- **Per-Chat Themes**: Theme settings that apply only to the current chat.
- **Per-Character Themes**: Theme settings that apply to all chats of the current character.
- **Auto-Save Slot**: Automatically backs up settings right before a theme change.
- **Slash Command Support**: Quickly save with `/themeSaveChat` and `/themeSaveChar` commands (includes force overwrite option).

### 🔄 Automatic Restoration System
- **Priority Application**: Applies themes in the order of Chat Theme → Character Theme → UI Default Settings.
- **Smart Auto-Save**: Intelligent saving method based on user experience.

### ⚙️ Advanced Management Functions
- **Advanced Settings Panel**: Select settings by category: Theme, UI, Message, and Other.
- **Default Options Management**: Set frequently used settings as your default.
- **Export/Import Settings**: Backup and recovery functions (full/individual).
- **Individual/Full Deletion**: Selectively delete only the settings you need.

## 🚀 Installation

1. In Extensions > Install Extension, enter the address `https://github.com/nonameaaai/ThemePresetManager`.
2. Restart SillyTavern.
3. Find and use the "Theme Preset Manager" extension in the right column of the UI Settings menu.

## 📖 How to Use

### Basic Setup
1. **Auto Apply Theme**: Enable the "Auto Apply Saved Theme" checkbox to use the automatic theme restoration feature when switching chats/characters (Recommended).
2. **Set Default Options**: In the "Advanced Settings" panel, check the settings you frequently use, then click the "Save Current as Default" button to create your own default save set (Recommended).

### Manual Saving
- **Save to Chat**: Saves the current theme to apply only to the current chat.
- **Save to Character**: Saves the current theme to apply to all chats of the current character.
- **Save Method**:
  - When the Advanced Settings panel is open: Only the **settings selected** in the panel are saved.
  - When the Advanced Settings panel is closed: Only your **pre-defined default options** are saved.

### Slash Commands (v1.1.0+)
- `/themeSaveChat`: Saves the current theme to the chat (shows confirmation prompt).
- `/themeSaveChat force=true`: Forces an overwrite to the chat without a confirmation prompt.
- `/themeSaveChar`: Saves the current theme to the character (shows confirmation prompt).
- `/themeSaveChar force=true`: Forces an overwrite to the character without a confirmation prompt.

### Manual Loading
- **Load from Chat / Load from Character**: Manually load saved themes with each button.
- **Restore from Auto Slot**: Reverts UI settings to the state just before the last theme change.

### Backup and Recovery
- **All Settings**: Export or import all character/chat themes and extension settings into a single file.
- **Specific Settings**: Export or import only the theme for the currently selected character or chat, making it easy to share themes with others.

## 🐛 Known Issues & Future Plans

- **Partial Localization**: While static UI text supports localization, some dynamically generated strings in JavaScript, such as `toastr` notifications or `confirm` prompts, are still displayed in English.
- **Future Plans**: Full localization (I18n) support for all dynamic strings will be added in the next version.

## 📝 Changelog

### **Version 1.1.0** (Current)
- **Feature**: Added Slash Commands (`/themeSaveChat`, `/themeSaveChar` with `force` option).
- **Improvement**: Introduced UI localization (I18n) system. Now supports English and Korean UI by default.
- **Improvement**: Refactored HTML structure to align with SillyTavern's standard practices.
- **Docs**: Added an English guide to the README and improved its structure.

### Version 1.0.0
- Basic theme save/load functionality.
- Per-character and per-chat theme management.
- Auto-apply theme and auto-save slot features.
- Settings export/import and advanced settings panel.

## 🤝 Contributing

Please submit bug reports or feature suggestions through GitHub Issues.

## 📄 License

AGPL-3.0