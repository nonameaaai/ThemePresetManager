// ThemePresetManager 확장 프로그램
// 캐릭터별, 채팅별로 테마와 사용자 설정을 자동저장하고 복원하는 확장

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, getCurrentChatId, this_chid, characters, chat_metadata, saveChatDebounced, getRequestHeaders, eventSource, event_types } from "../../../../script.js";
import { t } from '../../../i18n.js';
import { power_user, applyPowerUserSettings } from "../../../power-user.js";
import { background_settings } from '../../../backgrounds.js';

// 확장 프로그램 기본 정보
const extensionName = "ThemePresetManager";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const extensionSettings = extension_settings[extensionName];

// 스마트 자동저장을 위한 전역 변수들
let hasAdvancedSettingsBeenOpened = false;
let hasInitializedDefaultSettings = false;

// 기본 설정 객체 (extension_settings에 저장될 설정들)
const defaultSettings = {
    enabled: true, // 확장 활성화 여부
    autoApply: false, // 자동 적용 여부
    chatThemes: {}, // 채팅별 테마 저장소
    characterThemes: {}, // 캐릭터별 테마 저장소
    autoSaveSlot: null, // 자동 저장 슬롯 (복원 직전 값)
    defaultSelectedSettings: {}, // 기본으로 저장할 설정들
    useDefaultSettingsOnly: true // 기본 설정만 사용할지 여부
};

// 상세설정 기본값 (핵심 테마 요소들만 기본적으로 저장)
const defaultSelectedSettings = {
    // 핵심 테마 설정 (3개)
    theme: true,
    customCSS: true,
    background: true,
    
    // 색상 설정 (10개)
    main_text_color: true,
    italics_text_color: true,
    underline_text_color: true,
    quote_text_color: true,
    shadow_color: true,
    chat_tint_color: true,
    blur_tint_color: true,
    border_color: true,
    user_mes_blur_tint_color: true,
    bot_mes_blur_tint_color: true,
    
    // 레이아웃 & 크기 (4개)
    blur_strength: true,
    shadow_width: true,
    font_scale: true,
    chat_width: true,
    
    // UI 스타일 (3개)
    avatar_style: true,
    chat_display: true,
    toastr_position: true,
    
    // UI 모드 (3개)
    fast_ui_mode: true,
    waifuMode: true,
    noShadows: true,
    
    // 개별 처리 요소들 (5개) - 기본값일 때는 false, 사용자가 선택하거나 등록된 설정값에 준함
    aux_field: false,
    background_thumbnails_animation: false,
    relaxed_api_urls: false,
    example_messages_behavior: false,
    'auto-load-chat-checkbox': false
};

// 임시 selectedSettings 변수 (세션 동안만 유지)
let currentSelectedSettings = null;

// 캐릭터별 데이터 저장/로드 함수들 (SillyTavern 내부 구조 활용)
async function saveDataToCharacter(key, value) {
    if (this_chid === undefined || !characters[this_chid]) {
        console.error('ThemePresetManager: 캐릭터가 선택되지 않아 데이터를 저장할 수 없습니다.');
        return;
    }

    const character = characters[this_chid];

    // character.data 객체가 없으면 생성합니다.
    if (!character.data) character.data = {};
    if (!character.data.extensions) character.data.extensions = {};
    if (!character.data.extensions[extensionName]) character.data.extensions[extensionName] = {};

    // 확장 데이터 객체에 값을 할당합니다.
    character.data.extensions[extensionName][key] = value;
    //console.log(`ThemePresetManager: ${character.name} 캐릭터에 데이터 저장:`, { [key]: value });

    // 서버의 '/api/characters/merge-attributes' 엔드포인트로 변경사항을 전송하여 저장합니다.
    try {
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar: character.avatar,
                data: {
                    extensions: {
                        [extensionName]: { [key]: value }
                    }
                }
            })
        });

        if (!response.ok) {
            throw new Error(`서버 응답 오류: ${response.status}`);
        }
    } catch (error) {
        console.error('ThemePresetManager: 캐릭터 데이터 저장 중 오류 발생:', error);
    }
}

function loadDataFromCharacter(key, defaultValue = null) {
    if (this_chid === undefined || !characters[this_chid]) {
        return defaultValue;
    }

    const character = characters[this_chid];
    return character.data?.extensions?.[extensionName]?.[key] ?? defaultValue;
}

// 채팅별 데이터 저장/로드 함수들
function saveDataToChat(key, value) {
    if (!chat_metadata) chat_metadata = {};
    if (!chat_metadata.extensions) chat_metadata.extensions = {};
    if (!chat_metadata.extensions[extensionName]) chat_metadata.extensions[extensionName] = {};

    chat_metadata.extensions[extensionName][key] = value;
    //console.log('ThemePresetManager: 현재 채팅에 데이터 저장:', { [key]: value });

    // saveChatDebounced()를 호출하여 변경사항을 서버에 저장합니다.
    saveChatDebounced();
}

function loadDataFromChat(key, defaultValue = null) {
    return chat_metadata?.extensions?.[extensionName]?.[key] ?? defaultValue;
}

// 현재 상태 추적
let currentChatId = null;
let currentCharacterId = null;
let isRestoring = false;

// 현재 캐릭터 ID 가져오기 (SillyTavern 내부 구조 활용)
function getCurrentCharacterId() {
    try {
        // this_chid는 현재 선택된 캐릭터의 배열 인덱스입니다.
        if (this_chid === undefined || !characters[this_chid]) {
            console.warn('ThemePresetManager: 현재 선택된 캐릭터가 없습니다.');
            return null;
        }

        // characters 배열에서 해당 인덱스의 캐릭터 객체를 찾습니다.
        const currentCharacter = characters[this_chid];

        // 캐릭터의 'avatar' 속성이 고유한 파일명이자 ID입니다.
        const characterId = currentCharacter.avatar;
        //console.log('ThemePresetManager: 현재 캐릭터 ID 가져옴', characterId);
        return characterId;
    } catch (error) {
        console.error('ThemePresetManager: 캐릭터 ID 가져오기 오류', error);
        return null;
    }
}

// DEBUG: 확장 초기화 로그
//console.log('ThemePresetManager: 확장 초기화 시작');

// 설정 로드 함수
async function loadSettings() {
    //console.log('ThemePresetManager: 설정 로드 시작');
    
    // extension_settings에 확장 설정이 없으면 기본값으로 초기화
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = { ...defaultSettings };
        //console.log('ThemePresetManager: extension_settings 초기화됨');
    }
    
    // 필수 설정들이 없으면 기본값으로 초기화
    const settings = extension_settings[extensionName];
    
    if (settings.enabled === undefined) {
        settings.enabled = defaultSettings.enabled;
    }
    
    if (settings.autoApply === undefined) {
        settings.autoApply = defaultSettings.autoApply;
    }
    
    if (!settings.chatThemes) {
        settings.chatThemes = {};
    }
    
    if (!settings.characterThemes) {
        settings.characterThemes = {};
    }
    
    if (!settings.defaultSelectedSettings || Object.keys(settings.defaultSelectedSettings).length === 0) {
        settings.defaultSelectedSettings = { ...defaultSelectedSettings };
        //console.log('ThemePresetManager: defaultSelectedSettings를 기본값으로 초기화');
    }
    
    // 임시 selectedSettings 초기화 (세션 시작 시)
    currentSelectedSettings = null;
    //console.log('ThemePresetManager: currentSelectedSettings 초기화됨 (null)');
    
    // UI 업데이트
    updateUI();
    
    //console.log('ThemePresetManager: 설정 로드 완료', extension_settings[extensionName]);
}

// UI 업데이트 함수
function updateUI() {
    const settings = extension_settings[extensionName];
    
    $("#ThemePresetManager_enabled").prop("checked", settings.enabled).trigger("input");
    $("#ThemePresetManager_autoApply").prop("checked", settings.autoApply).trigger("input");
    $("#ThemePresetManager_useDefaultSettingsOnly").prop("checked", settings.useDefaultSettingsOnly !== false).trigger("input");
    
    // 현재 저장 상태 업데이트
    updateCurrentStatus();
    
    // 자동저장슬롯 상태에 따른 UI 업데이트
    updateAutoSlotUI();
    
    //console.log('ThemePresetManager: UI 업데이트 완료');
}

// 현재 채팅 이름 가져오기
function getCurrentChatName() {
    try {
        if (currentChatId) {
            // 채팅 ID에서 파일명 추출
            const fileName = currentChatId.split('/').pop()?.replace('.jsonl', '') || '';
            if (fileName) {
                return fileName;
            }
        }
        
        // 현재 캐릭터의 채팅 이름 사용
        if (this_chid !== undefined && characters[this_chid]) {
            return characters[this_chid].chat || '새 채팅';
        }
        
        return '새 채팅';
    } catch (error) {
        console.error('ThemePresetManager: 채팅 이름 가져오기 오류', error);
        return '알 수 없는 채팅';
    }
}

// 현재 캐릭터 이름 가져오기
function getCurrentCharacterName() {
    try {
        if (this_chid !== undefined && characters[this_chid]) {
            return characters[this_chid].name || '알 수 없는 캐릭터';
        }
        return '캐릭터 미선택';
    } catch (error) {
        console.error('ThemePresetManager: 캐릭터 이름 가져오기 오류', error);
        return '알 수 없는 캐릭터';
    }
}

// 현재 저장 상태 업데이트 함수 (새로운 내부 구조 방식 우선)
function updateCurrentStatus() {
    //console.log('ThemePresetManager: 현재 상태 업데이트 시작');
    
    const settings = extension_settings[extensionName];
    
    // 현재 ID 업데이트
    currentChatId = getCurrentChatId();
    currentCharacterId = getCurrentCharacterId();
    
    //console.log('ThemePresetManager: 현재 ID', { currentChatId, currentCharacterId });
    
    const chatStatus = $("#ThemePresetManager_chatStatus");
    const characterStatus = $("#ThemePresetManager_characterStatus");
    
    // UI 요소가 존재하는지 확인
    if (chatStatus.length === 0 || characterStatus.length === 0) {
        //console.log('ThemePresetManager: UI 요소가 아직 로드되지 않음, 상태 업데이트 건너뜀');
        return;
    }
    
    // 채팅 저장 상태 확인 (새로운 내부 구조 방식 우선)
    let chatTheme = loadDataFromChat('themeData');
    if (!chatTheme && currentChatId && settings.chatThemes && settings.chatThemes[currentChatId]) {
        chatTheme = settings.chatThemes[currentChatId];
        //console.log('ThemePresetManager: 기존 extension_settings에서 채팅 테마 확인');
    }
    
    if (chatTheme) {
        const savedTime = new Date(chatTheme.timestamp).toLocaleString();
        const themeName = chatTheme.theme?.theme || '기본 테마';
        const chatName = getCurrentChatName() || '현재 채팅';
        chatStatus.html(`✅ <strong>${chatName}</strong><br>📁 테마: <strong>${themeName}</strong><br>📅 저장일시: ${savedTime}`);
        //console.log('ThemePresetManager: 채팅 테마 상태 업데이트됨', { chatName, themeName });
    } else {
        const chatName = getCurrentChatName() || '현재 채팅';
        chatStatus.html(`❌ <strong>${chatName}</strong><br>저장된 테마가 없습니다.`);
        //console.log('ThemePresetManager: 채팅 테마 없음', { chatName });
    }
    
    // 캐릭터 저장 상태 확인 (새로운 내부 구조 방식 우선)
    let characterTheme = loadDataFromCharacter('themeData');
    if (!characterTheme && currentCharacterId && settings.characterThemes && settings.characterThemes[currentCharacterId]) {
        characterTheme = settings.characterThemes[currentCharacterId];
        //console.log('ThemePresetManager: 기존 extension_settings에서 캐릭터 테마 확인');
    }
    
    if (characterTheme) {
        const savedTime = new Date(characterTheme.timestamp).toLocaleString();
        const themeName = characterTheme.theme?.theme || '기본 테마';
        const characterName = getCurrentCharacterName() || '현재 캐릭터';
        characterStatus.html(`✅ <strong>${characterName}</strong><br>📁 테마: <strong>${themeName}</strong><br>📅 저장일시: ${savedTime}`);
        //console.log('ThemePresetManager: 캐릭터 테마 상태 업데이트됨', { characterName, themeName });
    } else {
        const characterName = getCurrentCharacterName() || '현재 캐릭터';
        characterStatus.html(`❌ <strong>${characterName}</strong><br>저장된 테마가 없습니다.`);
        //console.log('ThemePresetManager: 캐릭터 테마 없음', { characterName });
    }
    
    //console.log('ThemePresetManager: 현재 상태 업데이트 완료');
}

// 자동저장슬롯 상태에 따른 UI 업데이트
function updateAutoSlotUI() {
    //console.log('ThemePresetManager: 자동저장슬롯 UI 업데이트 시작');
    
    const settings = extension_settings[extensionName];
    const restoreButton = $("#ThemePresetManager_restoreFromAutoSlot");
    const deleteButton = $("#ThemePresetManager_deleteAutoSlot");
    const overwriteButton = $("#ThemePresetManager_overwriteAutoSlot");
    
    if (settings.autoSaveSlot) {
        // 자동저장슬롯이 있는 경우
        const savedTime = new Date(settings.autoSaveSlot.timestamp).toLocaleString();
        const themeCount = Object.keys(settings.autoSaveSlot.theme).length;
        const settingsCount = Object.keys(settings.autoSaveSlot.settings).length;
        
        // 복원 버튼 활성화
        restoreButton
            .prop('disabled', false)
            .removeClass('disabled-button')
            .addClass('enabled-button')
            .text(`자동 저장 슬롯에서 복원 (${themeCount}개 테마 + ${settingsCount}개 설정)`);
        
        // 삭제 버튼 활성화
        deleteButton
            .prop('disabled', false)
            .removeClass('disabled-button')
            .addClass('enabled-button')
            .text('자동 저장 슬롯 삭제');
        
        // 덮어쓰기 버튼 활성화
        overwriteButton
            .prop('disabled', false)
            .removeClass('disabled-button')
            .addClass('enabled-button')
            .text('현재 설정으로 덮어쓰기');
        
        console.log('ThemePresetManager: 자동저장슬롯 있음 - 버튼들 활성화', {
            savedTime,
            themeCount,
            settingsCount
        });
    } else {
        // 자동저장슬롯이 없는 경우
        // 복원 버튼 비활성화
        restoreButton
            .prop('disabled', true)
            .removeClass('enabled-button')
            .addClass('disabled-button')
            .text('자동 저장 슬롯에서 복원 (저장된 내용 없음)');
        
        // 삭제 버튼 비활성화
        deleteButton
            .prop('disabled', true)
            .removeClass('enabled-button')
            .addClass('disabled-button')
            .text('자동 저장 슬롯 삭제 (저장된 내용 없음)');
        
        // 덮어쓰기 버튼은 활성화 (새로 저장할 수 있으므로)
        overwriteButton
            .prop('disabled', false)
            .removeClass('disabled-button')
            .addClass('enabled-button')
            .text('현재 설정으로 저장 (새로 생성)');
        
        //console.log('ThemePresetManager: 자동저장슬롯 없음 - 복원/삭제 버튼 비활성화');
    }
}

// 현재 테마와 설정 가져오기 (선택된 설정만)
function getCurrentThemeAndSettings(selectedOnly = false, customSelectedSettings = null) {
    //console.log('ThemePresetManager: 현재 테마와 설정 수집 시작', { selectedOnly, customSelectedSettings });
    
    const settings = extension_settings[extensionName];
    const selectedSettings = customSelectedSettings || settings.selectedSettings || settings.defaultSelectedSettings || defaultSelectedSettings;
    //console.log('ThemePresetManager: getCurrentThemeAndSettings - selectedSettings 결정', { 
        customSelectedSettings: !!customSelectedSettings, 
        hasSelectedSettings: !!settings.selectedSettings, 
        hasDefaultSelectedSettings: !!settings.defaultSelectedSettings,
        finalSelectedSettings: selectedSettings 
    });
    
    const theme = {};
    const userSettings = {};
    
    // 1. 핵심 테마 설정들 (하드코딩)
    if (!selectedOnly || selectedSettings.theme) theme.theme = power_user.theme || 'default';
    if (!selectedOnly || selectedSettings.customCSS) theme.customCSS = power_user.custom_css || '';
    if (!selectedOnly || selectedSettings.background) {
        //console.log('ThemePresetManager: 배경 정보 수집 시작', { selectedOnly, backgroundSelected: selectedSettings.background });
        const currentBg = getCurrentBackground();
        if (currentBg) {
            theme.background = currentBg;
            //console.log('ThemePresetManager: 배경 정보 수집 완료', currentBg);
        } else {
            console.warn('ThemePresetManager: 배경 정보를 가져올 수 없음');
        }
    } else {
        //console.log('ThemePresetManager: 배경 정보 수집 건너뜀', { selectedOnly, backgroundSelected: selectedSettings.background });
    }
    
    // 2. Color picker 설정들 추가
    const colorSettings = [
        'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color',
        'shadow_color', 'chat_tint_color', 'blur_tint_color', 'border_color',
        'user_mes_blur_tint_color', 'bot_mes_blur_tint_color'
    ];
    
    colorSettings.forEach(colorKey => {
        if (!selectedOnly || selectedSettings[colorKey]) {
            if (power_user[colorKey]) {
                theme[colorKey] = power_user[colorKey];
            }
        }
    });
    
    // 3. 동적으로 power_user 객체에서 설정들 수집
    if (selectedOnly) {
        // 선택된 설정만 처리
        Object.keys(selectedSettings).forEach(key => {
            if (!selectedSettings[key] || key === 'theme' || key === 'customCSS' || key === 'background' || colorSettings.includes(key)) {
                return; // 이미 처리했거나 선택되지 않은 설정은 건너뛰기
            }
            
            // 새로운 설정들 특별 처리
            if (key === 'aux_field' || key === 'background_thumbnails_animation' || key === 'relaxed_api_urls' || 
                key === 'example_messages_behavior' || key === 'auto-load-chat-checkbox') {
                const value = getSpecialSettingValue(key);
                if (value !== undefined) {
                    userSettings[key] = value;
                }
                return;
            }
            
            // power_user에서 해당하는 키 찾기
            const powerUserKey = findPowerUserKey(key);
            if (powerUserKey && power_user.hasOwnProperty(powerUserKey)) {
                const value = power_user[powerUserKey];
                
                // 테마 관련 설정인지 확인
                if (isThemeSetting(key, powerUserKey)) {
                    theme[key] = value;
                } else {
                    userSettings[key] = value;
                }
            }
        });
    } else {
        // 기본 설정이 활성화되어 있으면 기본 설정만, 아니면 모든 설정
        const settings = extension_settings[extensionName];
        if (settings.useDefaultSettingsOnly) {
            // 기본 설정만 처리
            Object.keys(selectedSettings).forEach(key => {
                if (!selectedSettings[key] || key === 'theme' || key === 'customCSS' || key === 'background' || colorSettings.includes(key)) {
                    return; // 이미 처리했거나 선택되지 않은 설정은 건너뛰기
                }
                
                // 새로운 설정들 특별 처리
                if (key === 'aux_field' || key === 'background_thumbnails_animation' || key === 'relaxed_api_urls' || 
                    key === 'example_messages_behavior' || key === 'auto-load-chat-checkbox') {
                    const value = getSpecialSettingValue(key);
                    if (value !== undefined) {
                        userSettings[key] = value;
                    }
                    return;
                }
                
                // power_user에서 해당하는 키 찾기
                const powerUserKey = findPowerUserKey(key);
                if (powerUserKey && power_user.hasOwnProperty(powerUserKey)) {
                    const value = power_user[powerUserKey];
                    
                    // 테마 관련 설정인지 확인
                    if (isThemeSetting(key, powerUserKey)) {
                        theme[key] = value;
                    } else {
                        userSettings[key] = value;
                    }
                }
            });
        } else {
                    // 모든 설정 처리 - 기본옵션만 사용에서 true로 설정된 값들만
        const settings = extension_settings[extensionName];
        return getCurrentThemeAndSettings(true, settings.defaultSelectedSettings);
        }
    }
    
    //console.log('ThemePresetManager: 현재 테마와 설정 수집 완료', { theme, settings: userSettings, selectedOnly });
    return { theme, settings: userSettings };
}

// 설정이 테마 관련인지 확인하는 헬퍼 함수
function isThemeSetting(key, powerUserKey) {
    const themeKeywords = [
        'color', 'theme', 'css', 'blur', 'shadow', 'font', 'chat_width', 
        'avatar_style', 'chat_display', 'toastr_position', 'tint', 'border'
    ];
    
    const keyLower = (key + powerUserKey).toLowerCase();
    return themeKeywords.some(keyword => keyLower.includes(keyword));
}

// 모든 설정 가져오기 (자동 저장 슬롯용)
// getAllCurrentSettings 함수 제거 - power_user 전체 순회로 인한 민감한 정보 포함 문제
// 대신 getCurrentThemeAndSettings 함수를 사용하여 안전하게 설정 수집

// 테마와 설정 적용 함수
function applyThemeAndSettings(themeData, settingsData) {
    //console.log('ThemePresetManager: 테마와 설정 적용 시작', { themeData, settingsData });
    
    isRestoring = true;
    
    try {
        // 1. 핵심 테마 설정 적용 (하드코딩)
        if (themeData.theme !== undefined) {
            power_user.theme = themeData.theme;
            //console.log('ThemePresetManager: 테마 설정됨', themeData.theme);
            
            // 테마 드롭다운 업데이트
            $('#themes').val(themeData.theme);
            
            // 실제 테마 적용 함수 호출
            if (typeof applyTheme === 'function') {
                applyTheme(themeData.theme);
            }
        }
        
        // Custom CSS 적용
        if (themeData.customCSS !== undefined) {
            power_user.custom_css = themeData.customCSS;
            $('#customCSS').val(themeData.customCSS);
            if (typeof applyCustomCSS === 'function') {
                applyCustomCSS();
            }
        }
        
        // 배경 설정 적용
        if (themeData.background !== undefined) {
            const bg = themeData.background;
            //console.log('ThemePresetManager: 배경 설정 적용 시작', bg);
            if (bg.path) {
                // 저장된 잠금 상태를 확인하여 적절히 처리
                const shouldLock = bg.isLocked === true; // 명시적으로 true인 경우만 잠금
                //console.log('ThemePresetManager: 배경 경로 확인됨, setCurrentBackground 호출', bg.path, '잠금:', shouldLock);
                setCurrentBackground(bg.path, bg.style || 'cover', shouldLock);
                //console.log('ThemePresetManager: 배경 설정 적용 완료', bg);
            } else {
                console.warn('ThemePresetManager: 배경 경로가 없어서 적용하지 않음', bg);
            }
        } else {
            //console.log('ThemePresetManager: 배경 설정이 없어서 적용하지 않음');
        }
        
        // Color picker 설정들 적용
        const colorSettings = [
            'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color',
            'shadow_color', 'chat_tint_color', 'blur_tint_color', 'border_color',
            'user_mes_blur_tint_color', 'bot_mes_blur_tint_color'
        ];
        
        colorSettings.forEach(colorKey => {
            if (themeData[colorKey] !== undefined) {
                power_user[colorKey] = themeData[colorKey];
                
                // UI 요소 업데이트
                const elementId = colorKey.replace(/_/g, '-');
                const element = $(`#${elementId}`);
                if (element.length > 0) {
                    element.attr('color', themeData[colorKey]);
                }
                
                // 특별한 적용 함수 호출
                const colorTypeMap = {
                    'main_text_color': 'main',
                    'italics_text_color': 'italics',
                    'underline_text_color': 'underline',
                    'quote_text_color': 'quote',
                    'shadow_color': 'shadow',
                    'chat_tint_color': 'chatTint',
                    'blur_tint_color': 'blurTint',
                    'border_color': 'border',
                    'user_mes_blur_tint_color': 'userMesBlurTint',
                    'bot_mes_blur_tint_color': 'botMesBlurTint'
                };
                const colorType = colorTypeMap[colorKey];
                if (colorType && typeof applyThemeColor === 'function') {
                    applyThemeColor(colorType);
                }
                
                //console.log('ThemePresetManager: 색상 설정 적용됨', { colorKey, value: themeData[colorKey] });
            }
        });
        
        // 2. 동적으로 나머지 테마 설정들 적용
        Object.keys(themeData).forEach(key => {
            if (key === 'theme' || key === 'customCSS' || key === 'background') {
                return; // 이미 처리함
            }
            
            const value = themeData[key];
            if (value === undefined) return;
            
            // power_user에서 해당하는 키 찾기
            const powerUserKey = findPowerUserKey(key);
            if (powerUserKey && power_user.hasOwnProperty(powerUserKey)) {
                power_user[powerUserKey] = value;
                
                // UI 요소 업데이트
                updateUIElement(key, powerUserKey, value);
            }
        });
        
        // 3. 동적으로 사용자 설정들 적용
        Object.keys(settingsData).forEach(key => {
            const value = settingsData[key];
            if (value === undefined) return;
            
            // 새로운 설정들 특별 처리
            if (key === 'aux_field' || key === 'background_thumbnails_animation' || key === 'relaxed_api_urls' || 
                key === 'example_messages_behavior' || key === 'auto-load-chat-checkbox') {
                applySpecialSetting(key, value);
                return;
            }
            
            // power_user에서 해당하는 키 찾기
            const powerUserKey = findPowerUserKey(key);
            if (powerUserKey && power_user.hasOwnProperty(powerUserKey)) {
                power_user[powerUserKey] = value;
                
                // UI 요소 업데이트
                updateUIElement(key, powerUserKey, value);
            }
        });
        
        // power_user 설정 적용 함수 호출 (마지막에 호출하여 모든 설정이 적용된 후 UI 갱신)
        if (typeof applyPowerUserSettings === 'function') {
            applyPowerUserSettings();
        }
        
        // 설정 저장
        saveSettingsDebounced();
        
        //console.log('ThemePresetManager: 테마와 설정 적용 완료');
    } catch (error) {
        console.error('ThemePresetManager: 테마와 설정 적용 중 오류', error);
    } finally {
        isRestoring = false;
    }
}

// UI 요소 업데이트 헬퍼 함수
function updateUIElement(key, powerUserKey, value) {
    try {
        // ID 기반으로 요소 찾기 (방어적 코딩 강화)
        let element = $(`#${key}`);
        if (element.length === 0) {
            element = $(`#${powerUserKey}`);
        }
        if (element.length === 0) {
            // 변환된 이름으로 다시 시도
            const convertedId = powerUserKey.replace(/_/g, '-');
            element = $(`#${convertedId}`);
        }
        
        // Color picker의 경우 특별 처리
        if (element.length === 0 && powerUserKey.includes('_color')) {
            const colorKeyMap = {
                'main_text_color': 'main-text-color-picker',
                'italics_text_color': 'italics-color-picker',
                'underline_text_color': 'underline-color-picker',
                'quote_text_color': 'quote-color-picker',
                'shadow_color': 'shadow-color-picker',
                'chat_tint_color': 'chat-tint-color-picker',
                'blur_tint_color': 'blur-tint-color-picker',
                'border_color': 'border-color-picker',
                'user_mes_blur_tint_color': 'user-mes-blur-tint-color-picker',
                'bot_mes_blur_tint_color': 'bot-mes-blur-tint-color-picker'
            };
            const colorPickerId = colorKeyMap[powerUserKey];
            if (colorPickerId) {
                element = $(`#${colorPickerId}`);
            }
        }
        
        if (element.length === 0) {
            console.warn(`ThemePresetManager: UI 요소를 찾을 수 없음 - ${key} (${powerUserKey})`);
            return;
        }
        
        const tagName = element.prop('tagName').toLowerCase();
        const type = element.attr('type');
        
        try {
            switch (type || tagName) {
                case 'checkbox':
                    element.prop('checked', Boolean(value));
                    break;
                case 'radio':
                    if (element.val() == value) {
                        element.prop('checked', true);
                    }
                    break;
                case 'range':
                case 'number':
                    element.val(value);
                    // 카운터 요소도 업데이트 (연동 관계 고려)
                    const counterId = key.replace(/_slider$/, '_counter');
                    const counterElement = $(`#${counterId}`);
                    if (counterElement.length > 0) {
                        counterElement.val(value);
                    }
                    break;
                case 'select':
                case 'textarea':
                    element.val(value);
                    break;
                case 'toolcool-color-picker':
                    // color picker의 경우 color 속성 설정
                    if (value && typeof value === 'string') {
                        element.attr('color', value);
                    }
                    break;
                default:
                    if (element.hasClass('color-picker') || element.attr('color') !== undefined) {
                        element.attr('color', value);
                    } else {
                        element.val(value);
                    }
            }
        } catch (error) {
            console.warn(`ThemePresetManager: UI 요소 값 설정 실패 - ${key}:`, error);
        }
        
        // 특별한 적용 함수들 호출
        callSpecialApplyFunction(powerUserKey);
        
    } catch (error) {
        console.warn(`ThemePresetManager: UI 요소 업데이트 실패 - ${key}:`, error);
    }
}

// 특별한 적용 함수들 호출
function callSpecialApplyFunction(powerUserKey) {
    const applyFunctions = {
        'fast_ui_mode': 'switchUiMode',
        'noShadows': 'applyNoShadows',
        'movingUI': 'switchMovingUI',
        'waifuMode': 'switchWaifuMode',
        'spoiler_free_mode': 'switchSpoilerMode',
        'reduced_motion': 'switchReducedMotion',
        'compact_input_area': 'switchCompactInputArea',
        'background': 'setBackground',
        'font_scale': 'applyFontScale',
        'chat_width': 'applyChatWidth',
        'blur_strength': 'applyBlurStrength',
        'shadow_width': 'applyShadowWidth',
        'avatar_style': 'applyAvatarStyle',
        'chat_display': 'applyChatDisplay',
        'toastr_position': 'applyToastrPosition',
        // Color picker 관련 함수들 추가
        'main_text_color': 'applyThemeColor',
        'italics_text_color': 'applyThemeColor',
        'underline_text_color': 'applyThemeColor',
        'quote_text_color': 'applyThemeColor',
        'shadow_color': 'applyThemeColor',
        'chat_tint_color': 'applyThemeColor',
        'blur_tint_color': 'applyThemeColor',
        'border_color': 'applyThemeColor',
        'user_mes_blur_tint_color': 'applyThemeColor',
        'bot_mes_blur_tint_color': 'applyThemeColor'
    };
    
    const functionName = applyFunctions[powerUserKey];
    if (functionName && typeof window[functionName] === 'function') {
        try {
            if (powerUserKey === 'font_scale' || powerUserKey === 'chat_width') {
                window[functionName]('forced');
            } else if (powerUserKey.includes('_color')) {
                // Color picker의 경우 타입 매핑
                const colorTypeMap = {
                    'main_text_color': 'main',
                    'italics_text_color': 'italics',
                    'underline_text_color': 'underline',
                    'quote_text_color': 'quote',
                    'shadow_color': 'shadow',
                    'chat_tint_color': 'chatTint',
                    'blur_tint_color': 'blurTint',
                    'border_color': 'border',
                    'user_mes_blur_tint_color': 'userMesBlurTint',
                    'bot_mes_blur_tint_color': 'botMesBlurTint'
                };
                const colorType = colorTypeMap[powerUserKey];
                if (colorType) {
                    window[functionName](colorType);
                }
            } else {
                window[functionName]();
            }
        } catch (error) {
            console.warn(`ThemePresetManager: 특별 함수 호출 실패 - ${functionName}:`, error);
        }
    }
}

// 자동 저장 슬롯에 현재 설정 저장 (복원 직전 값)
function saveToAutoSlot() {
    //console.log('ThemePresetManager: 스마트 자동저장 - 자동 저장 슬롯에 저장 시작');
    
    const settings = extension_settings[extensionName];
    let currentSettings;
    let saveDescription;
    
    // 스마트 자동저장: 사용자 경험에 따른 분기
    if (hasAdvancedSettingsBeenOpened) {
        // 케이스 2-2: 사용자가 상세설정을 사용한 경우 - 전체선택과 동일
        //console.log('ThemePresetManager: 스마트 자동저장 - 상세설정 사용자 감지, 전체선택 사양으로 저장');
        // 상세설정 UI에서 체크된 모든 설정을 가져오기
        const selectedSettings = {};
        $('.setting-item input[type="checkbox"]:checked').each(function() {
            const key = $(this).attr('id').replace('setting_', '');
            selectedSettings[key] = true;
        });
        currentSettings = getCurrentThemeAndSettings(true, selectedSettings);
        saveDescription = '테마 변경 직전의 모든 설정 상태 (전체선택 사양)';
    } else {
        // 케이스 2-1: 사용자가 상세설정을 사용하지 않은 경우 - 기본옵션만
        //console.log('ThemePresetManager: 스마트 자동저장 - 상세설정 미사용자 감지, 기본옵션만 저장');
        const result = getCurrentThemeAndSettings(true, settings.defaultSelectedSettings);
        currentSettings = {
            theme: result.theme,
            settings: result.settings
        };
        saveDescription = '테마 변경 직전의 기본 설정 상태 (기본옵션만)';
    }
    
    settings.autoSaveSlot = {
        theme: currentSettings.theme,
        settings: currentSettings.settings,
        timestamp: Date.now(),
        description: saveDescription,
        savedWithAdvancedSettings: hasAdvancedSettingsBeenOpened
    };
    
    saveSettingsDebounced();
    //console.log('ThemePresetManager: 스마트 자동저장 - 자동 저장 슬롯에 저장 완료', {
        themeCount: Object.keys(currentSettings.theme).length,
        settingsCount: Object.keys(currentSettings.settings).length,
        description: saveDescription,
        상세설정_사용여부: hasAdvancedSettingsBeenOpened,
        저장_방식: hasAdvancedSettingsBeenOpened ? '전체선택' : '기본옵션만'
    });
    
    // UI 업데이트
    updateAutoSlotUI();
}

// 자동 저장 슬롯에서 설정 복원
function restoreFromAutoSlot() {
    //console.log('ThemePresetManager: 자동 저장 슬롯에서 복원 시작');
    
    const settings = extension_settings[extensionName];
    if (!settings.autoSaveSlot) {
        toastr.error('자동 저장 슬롯에 저장된 설정이 없습니다.');
        return false;
    }
    
    const savedTime = new Date(settings.autoSaveSlot.timestamp).toLocaleString();
    const themeCount = Object.keys(settings.autoSaveSlot.theme).length;
    const settingsCount = Object.keys(settings.autoSaveSlot.settings).length;
    
    applyThemeAndSettings(settings.autoSaveSlot.theme, settings.autoSaveSlot.settings);
    toastr.success(`자동 저장 슬롯의 설정으로 복원되었습니다. (${themeCount}개 테마 + ${settingsCount}개 설정, 저장시간: ${savedTime})`);
    //console.log('ThemePresetManager: 자동 저장 슬롯에서 복원 완료', {
        savedTime,
        themeCount,
        settingsCount
    });
    
    // UI 업데이트
    updateAutoSlotUI();
    return true;
}

// 자동 저장 슬롯 삭제
function deleteAutoSlot() {
    //console.log('ThemePresetManager: 자동 저장 슬롯 삭제 시작');
    
    const settings = extension_settings[extensionName];
    if (!settings.autoSaveSlot) {
        toastr.error('자동 저장 슬롯에 저장된 설정이 없습니다.');
        return false;
    }
    
    const savedTime = new Date(settings.autoSaveSlot.timestamp).toLocaleString();
    const themeCount = Object.keys(settings.autoSaveSlot.theme).length;
    const settingsCount = Object.keys(settings.autoSaveSlot.settings).length;
    
    delete settings.autoSaveSlot;
    saveSettingsDebounced();
    
    toastr.success(`자동 저장 슬롯이 삭제되었습니다. (${themeCount}개 테마 + ${settingsCount}개 설정, 저장시간: ${savedTime})`);
    //console.log('ThemePresetManager: 자동 저장 슬롯 삭제 완료', {
        savedTime,
        themeCount,
        settingsCount
    });
    
    // UI 업데이트
    updateAutoSlotUI();
    return true;
}

// 현재 설정으로 자동 저장 슬롯 덮어쓰기 (스마트 자동저장 사양)
function overwriteAutoSlot() {
    //console.log('ThemePresetManager: 스마트 자동저장 - 자동 저장 슬롯 덮어쓰기 시작');
    
    const settings = extension_settings[extensionName];
    
    // 기존 자동 저장 슬롯이 있는지 확인
    if (settings.autoSaveSlot) {
        const oldSavedTime = new Date(settings.autoSaveSlot.timestamp).toLocaleString();
        const oldThemeCount = Object.keys(settings.autoSaveSlot.theme).length;
        const oldSettingsCount = Object.keys(settings.autoSaveSlot.settings).length;
        
        //console.log('ThemePresetManager: 스마트 자동저장 - 기존 자동 저장 슬롯 정보', {
            oldSavedTime,
            oldThemeCount,
            oldSettingsCount,
            기존_저장방식: settings.autoSaveSlot.savedWithAdvancedSettings ? '전체선택' : '기본옵션만'
        });
    }
    
    // 스마트 자동저장: 사용자 경험에 따른 분기
    let currentSettings;
    let saveDescription;
    
    if (hasAdvancedSettingsBeenOpened) {
        // 케이스 2-2: 사용자가 상세설정을 사용한 경우 - 전체선택과 동일
        //console.log('ThemePresetManager: 스마트 자동저장 - 상세설정 사용자 감지, 전체선택 사양으로 덮어쓰기');
        // 상세설정 UI에서 체크된 모든 설정을 가져오기
        const selectedSettings = {};
        $('.setting-item input[type="checkbox"]:checked').each(function() {
            const key = $(this).attr('id').replace('setting_', '');
            selectedSettings[key] = true;
        });
        currentSettings = getCurrentThemeAndSettings(true, selectedSettings);
        saveDescription = '사용자가 수동으로 덮어쓴 모든 설정 상태 (전체선택 사양)';
    } else {
        // 케이스 2-1: 사용자가 상세설정을 사용하지 않은 경우 - 기본옵션만
        //console.log('ThemePresetManager: 스마트 자동저장 - 상세설정 미사용자 감지, 기본옵션만으로 덮어쓰기');
        const result = getCurrentThemeAndSettings(true, settings.defaultSelectedSettings);
        currentSettings = {
            theme: result.theme,
            settings: result.settings
        };
        saveDescription = '사용자가 수동으로 덮어쓴 기본 설정 상태 (기본옵션만)';
    }
    
    settings.autoSaveSlot = {
        theme: currentSettings.theme,
        settings: currentSettings.settings,
        timestamp: Date.now(),
        description: saveDescription,
        savedWithAdvancedSettings: hasAdvancedSettingsBeenOpened
    };
    
    saveSettingsDebounced();
    
    const newThemeCount = Object.keys(currentSettings.theme).length;
    const newSettingsCount = Object.keys(currentSettings.settings).length;
    
    if (settings.autoSaveSlot) {
        toastr.success(`자동 저장 슬롯이 현재 설정으로 덮어써졌습니다. (${newThemeCount}개 테마 + ${newSettingsCount}개 설정)`);
    } else {
        toastr.success(`자동 저장 슬롯에 현재 설정이 저장되었습니다. (${newThemeCount}개 테마 + ${newSettingsCount}개 설정)`);
    }
    
    //console.log('ThemePresetManager: 스마트 자동저장 - 자동 저장 슬롯 덮어쓰기 완료', {
        newThemeCount,
        newSettingsCount,
        description: saveDescription,
        상세설정_사용여부: hasAdvancedSettingsBeenOpened,
        저장_방식: hasAdvancedSettingsBeenOpened ? '전체선택' : '기본옵션만'
    });
    
    // UI 업데이트
    updateAutoSlotUI();
    return true;
}

// 테마 저장 함수 (기존 extension_settings 방식과 새로운 내부 구조 방식 모두 지원)
async function saveTheme(type, id) {
    //console.log('ThemePresetManager: 테마 저장 시작', { type, id });
    
    if (!id) {
        toastr.error(`${type === 'chat' ? '채팅' : '캐릭터'} ID를 찾을 수 없습니다.`);
        return null;
    }
    
    // 기존 저장된 데이터가 있는지 확인
    let existingData = null;
    if (type === 'chat') {
        existingData = loadDataFromChat('themeData');
        if (!existingData) {
            const settings = extension_settings[extensionName];
            existingData = settings.chatThemes?.[id];
        }
    } else {
        existingData = loadDataFromCharacter('themeData');
        if (!existingData) {
            const settings = extension_settings[extensionName];
            existingData = settings.characterThemes?.[id];
        }
    }
    
    // 기존 데이터가 있으면 확인창 표시
    if (existingData) {
        const savedTime = new Date(existingData.timestamp).toLocaleString();
        const confirmMessage = `${type === 'chat' ? '채팅' : '캐릭터'}에 이미 저장된 테마가 있습니다.\n\n저장일시: ${savedTime}\n\n기존 설정을 덮어쓰시겠습니까?`;
        
        if (!confirm(confirmMessage)) {
            //console.log('ThemePresetManager: 사용자가 저장을 취소함');
            return null;
        }
    }
    
    // 상세설정 패널이 열려있는지 확인 (기본옵션 사용 중단으로 단순화)
    const isAdvancedPanelOpen = $("#ThemePresetManager_advancedPanel").is(":visible");
    const settings = extension_settings[extensionName];
    //console.log('ThemePresetManager: 상세설정 패널 상태', { isAdvancedPanelOpen });
    
    // 저장할 설정 결정 (기본옵션 사용 중단으로 단순화)
    let themeData;
    let saveMessage;
    
    if (isAdvancedPanelOpen) {
        // 상세설정 패널이 열려있으면 선택된 설정만
        // 현재 체크된 설정들을 settings.selectedSettings에 저장
        const currentSelectedSettings = {};
        $('.setting-item input[type="checkbox"]:checked').each(function() {
            const key = $(this).attr('id').replace('setting_', '');
            currentSelectedSettings[key] = true;
        });
        settings.selectedSettings = currentSelectedSettings;
        //console.log('ThemePresetManager: 상세설정 패널 열림 - 현재 체크된 설정들을 selectedSettings에 저장', currentSelectedSettings);
        
        const result = getCurrentThemeAndSettings(true);
        themeData = {
            theme: result.theme,
            settings: result.settings,
            timestamp: Date.now(),
            savedWithAdvancedSettings: true
        };
        saveMessage = '선택된 설정만';
        //console.log('ThemePresetManager: 상세설정 패널 열림 - 선택된 설정만 저장');
    } else {
        // 상세설정 패널이 닫혀있으면 기본옵션만 저장 (민감한 정보 제외)
        const result = getCurrentThemeAndSettings(true, settings.defaultSelectedSettings);
        themeData = {
            theme: result.theme,
            settings: result.settings,
            timestamp: Date.now(),
            savedWithAdvancedSettings: false,
            savedWithDefaultSettings: true
        };
        saveMessage = '기본 옵션으로 설정된 것들만';
        //console.log('ThemePresetManager: 상세설정 패널 닫힘 - 기본 옵션만 저장 (민감한 정보 제외)');
    }
    
    // 새로운 내부 구조 방식으로 저장 (권장)
    if (type === 'chat') {
        // 채팅 메타데이터에 저장
        saveDataToChat('themeData', themeData);
        //console.log('ThemePresetManager: 채팅 테마를 내부 구조로 저장 완료', { saveMessage });
    } else {
        // 캐릭터 카드에 저장
        await saveDataToCharacter('themeData', themeData);
        //console.log('ThemePresetManager: 캐릭터 테마를 내부 구조로 저장 완료', { saveMessage });
    }
    
    // 기존 extension_settings 방식으로도 백업 저장
    if (type === 'chat') {
        if (!settings.chatThemes) settings.chatThemes = {};
        settings.chatThemes[id] = themeData;
    } else {
        if (!settings.characterThemes) settings.characterThemes = {};
        settings.characterThemes[id] = themeData;
    }
    saveSettingsDebounced();
    
    // UI 업데이트
    updateCurrentStatus();
    
    // 사용자에게 저장 방식 알림
    toastr.success(`${type === 'chat' ? '채팅' : '캐릭터'}에 ${saveMessage} 저장되었습니다.`);
    
    //console.log('ThemePresetManager: 테마 저장 완료', { type, id, saveMessage });
    return themeData;
}

// 테마 로드 함수 (새로운 내부 구조 방식 우선, 기존 방식 백업)
function loadTheme(type, id) {
    //console.log('ThemePresetManager: 테마 로드 시작', { type, id });
    
    let themeData = null;
    
    // 새로운 내부 구조 방식으로 먼저 시도
    if (type === 'chat') {
        themeData = loadDataFromChat('themeData');
        //console.log('ThemePresetManager: 채팅 테마를 내부 구조에서 로드 시도', themeData);
    } else {
        themeData = loadDataFromCharacter('themeData');
        //console.log('ThemePresetManager: 캐릭터 테마를 내부 구조에서 로드 시도', themeData);
    }
    
    // 내부 구조에서 찾지 못한 경우 기존 extension_settings 방식으로 백업
    if (!themeData) {
        const settings = extension_settings[extensionName];
        themeData = type === 'chat' 
            ? settings.chatThemes?.[id] 
            : settings.characterThemes?.[id];
        //console.log('ThemePresetManager: 기존 extension_settings에서 백업 로드 시도', themeData);
    }
    
    if (themeData) {
        applyThemeAndSettings(themeData.theme, themeData.settings);
        //console.log('ThemePresetManager: 테마 로드 완료', themeData);
        
        // 저장 방식에 따른 메시지 표시
        if (themeData.savedWithAdvancedSettings) {
            const appliedCount = Object.keys(themeData.theme).length + Object.keys(themeData.settings).length;
            toastr.success(`${type === 'chat' ? '채팅' : '캐릭터'} 테마가 적용되었습니다. (선택된 ${appliedCount}개 설정)`);
        } else if (themeData.savedWithDefaultSettings) {
            const appliedCount = Object.keys(themeData.theme).length + Object.keys(themeData.settings).length;
            toastr.success(`${type === 'chat' ? '채팅' : '캐릭터'} 테마가 적용되었습니다. (기본 옵션 ${appliedCount}개 설정)`);
        } else {
            const appliedCount = Object.keys(themeData.theme).length + Object.keys(themeData.settings).length;
            toastr.success(`${type === 'chat' ? '채팅' : '캐릭터'} 테마가 적용되었습니다. (모든 설정 ${appliedCount}개)`);
        }
        
        return themeData;
    } else {
        //console.log('ThemePresetManager: 테마를 찾을 수 없음', { type, id });
        toastr.error(`${type === 'chat' ? '채팅' : '캐릭터'}에 저장된 테마가 없습니다.`);
        return null;
    }
}

// 자동 테마 적용 함수 (새로운 내부 구조 방식 우선)
function autoApplyTheme() {
    //console.log('ThemePresetManager: 자동 테마 적용 시작');
    
    const settings = extension_settings[extensionName];
    if (!settings.enabled || !settings.autoApply) {
        //console.log('ThemePresetManager: 자동 적용이 비활성화되어 건너뜀');
        return;
    }
    
    // 현재 ID 업데이트
    currentChatId = getCurrentChatId();
    currentCharacterId = getCurrentCharacterId();
    
    //console.log('ThemePresetManager: 현재 ID 확인', { currentChatId, currentCharacterId });
    
    let applied = false;
    
    // 채팅 테마 먼저 확인 (새로운 내부 구조 방식 우선)
    let chatTheme = loadDataFromChat('themeData');
    if (!chatTheme && currentChatId && settings.chatThemes && settings.chatThemes[currentChatId]) {
        chatTheme = settings.chatThemes[currentChatId];
        //console.log('ThemePresetManager: 기존 extension_settings에서 채팅 테마 로드');
    }
    
    if (chatTheme) {
        //console.log('ThemePresetManager: 채팅 테마 발견, 적용 시작', chatTheme);
        applyThemeAndSettings(chatTheme.theme, chatTheme.settings);
        applied = true;
        //console.log('ThemePresetManager: 채팅 자동 테마 적용됨');
    }
    
    // 채팅에 없으면 캐릭터 테마 확인 (새로운 내부 구조 방식 우선)
    if (!applied) {
        let characterTheme = loadDataFromCharacter('themeData');
        if (!characterTheme && currentCharacterId && settings.characterThemes && settings.characterThemes[currentCharacterId]) {
            characterTheme = settings.characterThemes[currentCharacterId];
            //console.log('ThemePresetManager: 기존 extension_settings에서 캐릭터 테마 로드');
        }
        
        if (characterTheme) {
            //console.log('ThemePresetManager: 캐릭터 테마 발견, 적용 시작', characterTheme);
            applyThemeAndSettings(characterTheme.theme, characterTheme.settings);
            applied = true;
            //console.log('ThemePresetManager: 캐릭터 자동 테마 적용됨');
        }
    }
    
    if (!applied) {
        //console.log('ThemePresetManager: 자동 적용할 테마가 없음');
    }
    
    // UI 상태 업데이트
    updateCurrentStatus();
    
    //console.log('ThemePresetManager: 자동 테마 적용 완료', { applied, currentChatId, currentCharacterId });
}

// 자동 테마 적용 전에 현재 설정을 자동 저장 슬롯에 저장
function autoApplyThemeWithSave() {
    //console.log('ThemePresetManager: 자동 테마 적용 (저장 포함) 시작');
    
    const settings = extension_settings[extensionName];
    if (!settings.enabled || !settings.autoApply) {
        //console.log('ThemePresetManager: 자동 적용이 비활성화되어 건너뜀');
        return;
    }
    
    // 현재 ID 업데이트
    currentChatId = getCurrentChatId();
    currentCharacterId = getCurrentCharacterId();
    
    //console.log('ThemePresetManager: 현재 ID 확인', { currentChatId, currentCharacterId });
    
    // 복원할 테마가 있는지 먼저 확인
    let hasThemeToRestore = false;
    
    // 채팅 테마 확인
    let chatTheme = loadDataFromChat('themeData');
    if (!chatTheme && currentChatId && settings.chatThemes && settings.chatThemes[currentChatId]) {
        chatTheme = settings.chatThemes[currentChatId];
    }
    if (chatTheme) hasThemeToRestore = true;
    
    // 캐릭터 테마 확인
    if (!hasThemeToRestore) {
        let characterTheme = loadDataFromCharacter('themeData');
        if (!characterTheme && currentCharacterId && settings.characterThemes && settings.characterThemes[currentCharacterId]) {
            characterTheme = settings.characterThemes[currentCharacterId];
        }
        if (characterTheme) hasThemeToRestore = true;
    }
    
    // 복원할 테마가 있고, 아직 자동 저장 슬롯에 저장되지 않았다면 현재 설정을 저장
    if (hasThemeToRestore && !settings.autoSaveSlot) {
        //console.log('ThemePresetManager: 복원 직전 설정을 자동 저장 슬롯에 저장');
        saveToAutoSlot();
    }
    
    // 기존 자동 테마 적용 로직 실행
    autoApplyTheme();
}

// 설정 내보내기 함수
function exportSettings() {
    //console.log('ThemePresetManager: 설정 내보내기 시작');
    
    const settings = extension_settings[extensionName];
    
    // 우리 확장에서 관리하는 설정만 정확히 내보내기 (임시 selectedSettings 제외)
    const exportData = {
        version: '1.0.0',
        timestamp: Date.now(),
        extensionName: extensionName,
        settings: {
            enabled: settings.enabled,
            autoApply: settings.autoApply,
            useDefaultSettingsOnly: settings.useDefaultSettingsOnly,
            defaultSelectedSettings: settings.defaultSelectedSettings || defaultSelectedSettings,
            // 저장된 테마 데이터들
            chatThemes: settings.chatThemes || {},
            characterThemes: settings.characterThemes || {},
            autoSaveSlot: settings.autoSaveSlot || null
        }
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ThemePresetManager_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    //console.log('ThemePresetManager: 설정 내보내기 완료 (임시 selectedSettings 제외)', exportData);
}

// 설정 가져오기 함수
function importSettings(file) {
    //console.log('ThemePresetManager: 설정 가져오기 시작');
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importData = JSON.parse(e.target.result);
            
            // 파일 형식 검증
            if (!importData.extensionName || importData.extensionName !== extensionName) {
                throw new Error('이 파일은 ThemePresetManager 확장의 설정 파일이 아닙니다.');
            }
            
            if (!importData.settings) {
                throw new Error('설정 데이터가 없습니다.');
            }
            
            // 가져오기 방식 선택 (대체 vs 병합)
            const isMergeMode = confirm(
                '설정 가져오기 방식을 선택하세요:\n\n' +
                '확인: 병합 모드 (기존 설정과 합치기)\n' +
                '취소: 대체 모드 (기존 설정을 완전히 덮어쓰기)\n\n' +
                '병합 모드는 기존 설정을 유지하면서 새로운 설정을 추가합니다.\n' +
                '대체 모드는 모든 기존 설정을 삭제하고 새로운 설정으로 교체합니다.'
            );
            
            //console.log('ThemePresetManager: 가져오기 방식 선택됨', { isMergeMode });
            
            const currentSettings = extension_settings[extensionName] || {};
            const newSettings = importData.settings;
            
            if (isMergeMode) {
                // 병합 모드: 기존 설정과 합치기
                //console.log('ThemePresetManager: 병합 모드로 설정 가져오기');
                extension_settings[extensionName] = {
                    ...currentSettings,
                    enabled: newSettings.enabled !== undefined ? newSettings.enabled : currentSettings.enabled,
                    autoApply: newSettings.autoApply !== undefined ? newSettings.autoApply : currentSettings.autoApply,
                    useDefaultSettingsOnly: newSettings.useDefaultSettingsOnly !== undefined ? newSettings.useDefaultSettingsOnly : currentSettings.useDefaultSettingsOnly,
                    defaultSelectedSettings: newSettings.defaultSelectedSettings || currentSettings.defaultSelectedSettings || defaultSelectedSettings,
                    chatThemes: { ...currentSettings.chatThemes, ...newSettings.chatThemes },
                    characterThemes: { ...currentSettings.characterThemes, ...newSettings.characterThemes },
                    autoSaveSlot: newSettings.autoSaveSlot || currentSettings.autoSaveSlot || null
                };
            } else {
                // 대체 모드: 기존 설정을 완전히 덮어쓰기
                //console.log('ThemePresetManager: 대체 모드로 설정 가져오기');
                extension_settings[extensionName] = {
                    enabled: newSettings.enabled !== undefined ? newSettings.enabled : defaultSettings.enabled,
                    autoApply: newSettings.autoApply !== undefined ? newSettings.autoApply : defaultSettings.autoApply,
                    useDefaultSettingsOnly: newSettings.useDefaultSettingsOnly !== undefined ? newSettings.useDefaultSettingsOnly : defaultSettings.useDefaultSettingsOnly,
                    defaultSelectedSettings: newSettings.defaultSelectedSettings || defaultSelectedSettings,
                    chatThemes: newSettings.chatThemes || {},
                    characterThemes: newSettings.characterThemes || {},
                    autoSaveSlot: newSettings.autoSaveSlot || null
                };
            }
            
            // 임시 selectedSettings 초기화 (가져오기 후 새로고침 효과)
            currentSelectedSettings = null;
            //console.log('ThemePresetManager: 설정 가져오기 후 currentSelectedSettings 초기화됨');
            
            saveSettingsDebounced();
            updateUI();
            
            //console.log('ThemePresetManager: 설정 가져오기 완료', { 
                mode: isMergeMode ? '병합' : '대체',
                importedSettings: extension_settings[extensionName] 
            });
            toastr.success(`설정이 성공적으로 가져와졌습니다. (${isMergeMode ? '병합' : '대체'} 모드)`);
        } catch (error) {
            console.error('ThemePresetManager: 설정 가져오기 오류', error);
            toastr.error(`설정 가져오기에 실패했습니다: ${error.message}`);
        }
    };
    reader.readAsText(file);
}

// 상세설정 UI 생성
function createAdvancedSettingsUI() {
    //console.log('ThemePresetManager: 상세설정 UI 생성 시작 - 최신 상태로 UI 업데이트');
    
    // 스마트 자동저장: 기본 설정 초기화 먼저 실행
    initializeDefaultSettingsIfNeeded();
    
    // 1. 현재 선택된 설정 확인 (초기화 후 최신 설정 사용)
    const hasCurrentSelected = currentSelectedSettings !== null;
    const selectedSettings = hasCurrentSelected ? currentSelectedSettings : (extension_settings[extensionName]?.defaultSelectedSettings || defaultSelectedSettings);
    
    //console.log('ThemePresetManager: 상세설정 UI 생성 - 사용할 설정', { hasCurrentSelected, selectedSettings });
    
    // 2. 카테고리별 설정 객체 초기화
    const categorizedSettings = {
        theme: [],
        ui: [],
        message: [],
        other: []
    };
    
    // 3. 핵심 설정들 (하드코딩)
    const coreSettings = [
        { key: 'theme', label: '테마', value: power_user.theme || '기본값', element: $('#themes'), type: 'select' },
        { key: 'customCSS', label: '커스텀 CSS', value: power_user.customCSS ? '설정됨' : '설정안됨', element: $('#customCSS'), type: 'textarea' }
    ];
    
    // 배경 정보 수집
    const currentBg = getCurrentBackground();
    if (currentBg) {
        coreSettings.push({
            key: 'background',
            label: '배경 이미지',
            value: `${currentBg.path} (${currentBg.style})`,
            element: null,
            type: 'background'
        });
    }
    
    //console.log('ThemePresetManager: 핵심 설정들', coreSettings.length, coreSettings);
    
    // 4. 핵심 설정들을 테마 카테고리에 추가
    coreSettings.forEach(setting => {
        categorizedSettings.theme.push(setting);
        //console.log(`ThemePresetManager: 핵심 설정 추가됨 - ${setting.key} (theme)`, setting);
    });
    
    // 5. 보안상 제외할 설정들
    const EXCLUDED_SETTINGS = [
        'password', 'api_key', 'token', 'secret', 'auth', 'login', 'credential',
        'openai_key', 'claude_key', 'palm_key', 'cohere_key', 'ai21_key',
        'server_urls', 'proxy', 'endpoint', 'api_url', 'base_url',
        'user_name', 'user_id', 'session', 'cookie'
    ];
    
    // 6. 기존에 잘 작동하던 DOM 요소 수집 로직 (완전 복원)
    //console.log('ThemePresetManager: DOM 요소 수집 시작');
    
    // 중복 방지를 위한 제외 목록
    const DUPLICATE_EXCLUSIONS = [
        'themes', 'customCSS', 'background', // 하드코딩된 핵심 설정들
        'chat_width_slider_counter', 'font_scale_counter', 'blur_strength_counter', 'shadow_width_counter', // 연동된 counter들
        'chat_truncation_counter', 'streaming_fps_counter' // 연동된 counter들
    ];
    
    const allElements = $('#user-settings-block').find('input, select, textarea, toolcool-color-picker');
    //console.log('ThemePresetManager: 찾은 요소들 수', allElements.length);
    //console.log('ThemePresetManager: toolcool-color-picker 요소들', $('#user-settings-block').find('toolcool-color-picker').length);
    
    let processedCount = 0;
    let excludedCount = 0;
    let powerUserNotFoundCount = 0;
    let hiddenExcludedCount = 0;
    
    // 이미 처리된 키들 (중복 방지)
    const processedKeys = new Set();
    Object.values(categorizedSettings).forEach(category => {
        category.forEach(setting => processedKeys.add(setting.key));
    });
    
    allElements.each(function() {
        const element = $(this);
        const id = element.attr('id');
        const name = element.attr('name');
        const type = element.attr('type') || element.prop('tagName').toLowerCase();
        const dataFor = element.attr('data-for');
        
        // Color picker 디버깅
        if (type === 'toolcool-color-picker') {
            //console.log('ThemePresetManager: Color picker 발견', { id, name, type });
        }
        
        // data-for 속성이 있으면 보조 요소이므로 건너뛰기 (연동 관계 고려)
        if (dataFor) {
            //console.log('ThemePresetManager: data-for 속성으로 제외', { id, dataFor });
            return;
        }
        
        if (!id && !name) {
            //console.log('ThemePresetManager: ID/name 없음으로 제외', { id, name });
            return;
        }
        
        const settingKey = id || name;
        //console.log('ThemePresetManager: 처리 중인 요소', { settingKey, type });
        
        // 이미 처리된 설정이나 제외 목록에 있는 설정은 건너뛰기
        if (processedKeys.has(settingKey)) {
            //console.log('ThemePresetManager: 이미 처리된 키로 제외', settingKey);
            return;
        }
        
        // 보안 제외 목록에서 예외 처리
        const isExcluded = EXCLUDED_SETTINGS.some(excluded => settingKey.toLowerCase().includes(excluded.toLowerCase()));
        if (isExcluded) {
            // 예외 처리: relaxed_api_urls는 허용
            if (settingKey === 'relaxed_api_urls') {
                //console.log('ThemePresetManager: relaxed_api_urls 예외 처리로 허용', settingKey);
            } else {
                //console.log('ThemePresetManager: 보안 제외 목록으로 제외', settingKey);
                excludedCount++;
                return;
            }
        }
        
        if (DUPLICATE_EXCLUSIONS.includes(settingKey)) {
            //console.log('ThemePresetManager: 중복 제외 목록으로 제외', settingKey);
            return;
        }
        
        // power_user에 해당하는 키가 있는지 확인
        const powerUserKey = findPowerUserKey(settingKey);
        if (!powerUserKey) {
                    // 새로운 설정들 예외 처리
        if (settingKey === 'aux_field' || settingKey === 'background_thumbnails_animation' || 
            settingKey === 'relaxed_api_urls' || settingKey === 'example_messages_behavior' || 
            settingKey === 'auto-load-chat-checkbox' || settingKey === 'messageTimerEnabled' ||
            settingKey === 'messageTimestampsEnabled' || settingKey === 'messageModelIconEnabled' ||
            settingKey === 'mesIDDisplayEnabled' || settingKey === 'hideChatAvatarsEnabled' ||
            settingKey === 'messageTokensEnabled' || settingKey === 'pin_styles') {
            //console.log(`ThemePresetManager: 새로운 설정으로 허용 - ${settingKey}`);
        }
            // Color picker의 경우 특별 처리
            else if (type === 'toolcool-color-picker') {
                const colorKeyMap = {
                    'main-text-color-picker': 'main_text_color',
                    'italics-color-picker': 'italics_text_color',
                    'underline-color-picker': 'underline_text_color',
                    'quote-color-picker': 'quote_text_color',
                    'shadow-color-picker': 'shadow_color',
                    'chat-tint-color-picker': 'chat_tint_color',
                    'blur-tint-color-picker': 'blur_tint_color',
                    'border-color-picker': 'border_color',
                    'user-mes-blur-tint-color-picker': 'user_mes_blur_tint_color',
                    'bot-mes-blur-tint-color-picker': 'bot_mes_blur_tint_color'
                };
                
                const mappedKey = colorKeyMap[settingKey];
                if (mappedKey && power_user.hasOwnProperty(mappedKey)) {
                    //console.log(`ThemePresetManager: Color picker 키 매핑 성공 - ${settingKey} → ${mappedKey}`);
                } else {
                    //console.log(`ThemePresetManager: Color picker 키 매핑 실패 - ${settingKey}`);
                    powerUserNotFoundCount++;
                    return;
                }
            } else {
                //console.log(`ThemePresetManager: power_user 키를 찾을 수 없음 - ${settingKey}`);
                powerUserNotFoundCount++;
                return;
            }
        } else {
            //console.log(`ThemePresetManager: power_user 키 찾음 - ${settingKey} → ${powerUserKey}`);
        }
        
        // 숨겨진, 비활성화된, 개발자 전용 요소들 제외
        if (element.prop('disabled') || 
            element.hasClass('hidden') ||
            element.hasClass('disabled') ||
            element.attr('style')?.includes('display: none') ||
            element.attr('style')?.includes('visibility: hidden') ||
            (settingKey.includes('aux_field') && settingKey !== 'aux_field') || // aux_field 자체는 허용, 다른 aux_field 관련은 제외
            settingKey.includes('debug') ||
            settingKey.includes('dev_') ||
            settingKey.includes('internal_') ||
            (settingKey.includes('pin_') && settingKey !== 'pin_styles') || // pin_styles는 허용, 다른 pin_ 관련은 제외
            settingKey.includes('greeting_')) {
            //console.log(`ThemePresetManager: 숨겨진/비활성화 요소로 제외 - ${settingKey}`);
            hiddenExcludedCount++;
            return;
        }
        
        // 추가 디버깅: 실제로 보이는지 확인
        const isVisible = element.is(':visible');
        const offset = element.offset();
        const hasOffset = offset && offset.top !== undefined && offset.left !== undefined;
        
        //console.log(`ThemePresetManager: 요소 가시성 확인 - ${settingKey}:`, {
            isVisible,
            hasOffset,
            offset,
            disabled: element.prop('disabled'),
            hiddenClass: element.hasClass('hidden'),
            disabledClass: element.hasClass('disabled'),
            style: element.attr('style')
        });
        
        processedKeys.add(settingKey);
        processedCount++;
        
        // Color picker의 경우 powerUserKey 재설정
        let finalPowerUserKey = powerUserKey;
        if (type === 'toolcool-color-picker') {
            const colorKeyMap = {
                'main-text-color-picker': 'main_text_color',
                'italics-color-picker': 'italics_text_color',
                'underline-color-picker': 'underline_text_color',
                'quote-color-picker': 'quote_text_color',
                'shadow-color-picker': 'shadow_color',
                'chat-tint-color-picker': 'chat_tint_color',
                'blur-tint-color-picker': 'blur_tint_color',
                'border-color-picker': 'border_color',
                'user-mes-blur-tint-color-picker': 'user_mes_blur_tint_color',
                'bot-mes-blur-tint-color-picker': 'bot_mes_blur_tint_color'
            };
            finalPowerUserKey = colorKeyMap[settingKey];
        }
        
        // 새로운 설정들의 경우 powerUserKey 설정
        if (settingKey === 'aux_field' || settingKey === 'background_thumbnails_animation' || 
            settingKey === 'relaxed_api_urls' || settingKey === 'example_messages_behavior' || 
            settingKey === 'auto-load-chat-checkbox' || settingKey === 'messageTimerEnabled' ||
            settingKey === 'messageTimestampsEnabled' || settingKey === 'messageModelIconEnabled' ||
            settingKey === 'mesIDDisplayEnabled' || settingKey === 'hideChatAvatarsEnabled' ||
            settingKey === 'messageTokensEnabled' || settingKey === 'pin_styles') {
            finalPowerUserKey = settingKey; // 자기 자신을 키로 사용
        }
        
        // 실제 라벨 텍스트 찾기 (i18n 지원 개선)
        let label = settingKey;
        
        // 1. 가장 가까운 label 요소에서 텍스트 찾기
        const labelElement = element.closest('label');
        if (labelElement.length > 0) {
            // data-i18n 속성을 가진 small 요소 우선 확인
            const i18nSmall = labelElement.find('small[data-i18n]').first();
            if (i18nSmall.length > 0) {
                const i18nText = i18nSmall.text().trim();
                if (i18nText) {
                    label = i18nText;
                    //console.log(`ThemePresetManager: i18n small 요소에서 라벨 찾음 - ${settingKey} → ${label}`);
                }
            } else {
                // 일반적인 small, span 요소 확인
                const labelText = labelElement.find('small, span').first().text().trim();
                if (labelText) {
                    label = labelText;
                }
            }
        }
        
        // 2. 이전 형제 요소에서 텍스트 찾기 (color picker의 경우)
        if (label === settingKey && type === 'toolcool-color-picker') {
            const prevSpan = element.prev('span');
            if (prevSpan.length > 0) {
                const spanText = prevSpan.text().trim();
                if (spanText) {
                    label = spanText;
                }
            }
        }
        
        // 3. 부모 컨테이너에서 data-i18n 요소 찾기
        if (label === settingKey) {
            const parentContainer = element.closest('.flex-container');
            if (parentContainer.length > 0) {
                // data-i18n 속성을 가진 small 요소 우선 확인
                const i18nSmall = parentContainer.find('small[data-i18n]').first();
                if (i18nSmall.length > 0) {
                    const i18nText = i18nSmall.text().trim();
                    if (i18nText) {
                        label = i18nText;
                        //console.log(`ThemePresetManager: 부모 컨테이너 i18n small에서 라벨 찾음 - ${settingKey} → ${label}`);
                    }
                } else {
                    // 일반적인 span[data-i18n] 확인
                    const containerText = parentContainer.find('span[data-i18n]').first().text().trim();
                    if (containerText) {
                        label = containerText;
                    }
                }
            }
        }
        
        // 4. 추가: 직접적인 부모에서 data-i18n 요소 찾기
        if (label === settingKey) {
            const directParent = element.parent();
            const i18nSmall = directParent.find('small[data-i18n]').first();
            if (i18nSmall.length > 0) {
                const i18nText = i18nSmall.text().trim();
                if (i18nText) {
                    label = i18nText;
                    //console.log(`ThemePresetManager: 직접 부모 i18n small에서 라벨 찾음 - ${settingKey} → ${label}`);
                }
            }
        }
        
        // 현재 값 가져오기 (방어적 코딩 추가)
        let currentValue = '';
        try {
            // 새로운 설정들 특별 처리
            if (settingKey === 'aux_field' || settingKey === 'background_thumbnails_animation' || 
                settingKey === 'relaxed_api_urls' || settingKey === 'example_messages_behavior' || 
                settingKey === 'auto-load-chat-checkbox' || settingKey === 'messageTimerEnabled' ||
                settingKey === 'messageTimestampsEnabled' || settingKey === 'messageModelIconEnabled' ||
                settingKey === 'mesIDDisplayEnabled' || settingKey === 'hideChatAvatarsEnabled' ||
                settingKey === 'messageTokensEnabled' || settingKey === 'pin_styles') {
                const specialValue = getSpecialSettingValue(settingKey);
                if (settingKey === 'aux_field') {
                    currentValue = specialValue ? '설정됨' : '설정안됨';
                } else if (settingKey === 'example_messages_behavior') {
                    const behaviorMap = {
                        'normal': '토큰 초과 시 점진적 밀어내기',
                        'keep': '항상 컨텍스트에 예제 포함',
                        'strip': '절대로 예제 포함 안 함'
                    };
                    currentValue = behaviorMap[specialValue] || specialValue || '기본값';
                } else {
                    currentValue = specialValue ? '활성화' : '비활성화';
                }
            } else {
                switch (type) {
                    case 'checkbox':
                        currentValue = element.is(':checked') ? '활성화' : '비활성화';
                        break;
                    case 'radio':
                        if (element.is(':checked')) {
                            currentValue = element.val() || '선택됨';
                        } else {
                            return; // 선택되지 않은 라디오 버튼은 건너뛰기
                        }
                        break;
                    case 'select':
                        const selectedOption = element.find('option:selected');
                        currentValue = selectedOption.text() || element.val() || '기본값';
                        break;
                    case 'range':
                        currentValue = element.val() || '0';
                        break;
                    case 'color':
                        currentValue = element.attr('color') || element.val() || '기본값';
                        break;
                    case 'textarea':
                        currentValue = element.val() ? '설정됨' : '설정안됨';
                        break;
                    case 'toolcool-color-picker':
                        // color picker의 경우 color 속성이나 실제 색상 값 확인
                        const colorValue = element.attr('color') || element.val();
                        currentValue = colorValue ? '색상 설정됨' : '기본색상';
                        break;
                    default:
                        currentValue = element.val() || '기본값';
                }
            }
        } catch (error) {
            console.warn(`ThemePresetManager: 값 가져오기 실패 - ${settingKey}:`, error);
            currentValue = '오류';
        }
        
        // Color picker의 경우 키 매핑
        let finalKey = settingKey;
        if (type === 'toolcool-color-picker') {
            const colorKeyMap = {
                'main-text-color-picker': 'main_text_color',
                'italics-color-picker': 'italics_text_color',
                'underline-color-picker': 'underline_text_color',
                'quote-color-picker': 'quote_text_color',
                'shadow-color-picker': 'shadow_color',
                'chat-tint-color-picker': 'chat_tint_color',
                'blur-tint-color-picker': 'blur_tint_color',
                'border-color-picker': 'border_color',
                'user-mes-blur-tint-color-picker': 'user_mes_blur_tint_color',
                'bot-mes-blur-tint-color-picker': 'bot_mes_blur_tint_color'
            };
            finalKey = colorKeyMap[settingKey] || settingKey;
        }
        
        // UI/레이아웃 관련 키 매핑
        const uiKeyMap = {
            'blur_strength_slider': 'blur_strength',
            'shadow_width_slider': 'shadow_width',
            'font_scale_slider': 'font_scale',
            'chat_width_slider': 'chat_width',
            'avatar_style_select': 'avatar_style',
            'chat_display_select': 'chat_display',
            'toastr_position_select': 'toastr_position',
            'fast_ui_mode_checkbox': 'fast_ui_mode',
            'waifuMode_checkbox': 'waifuMode',
            'noShadows_checkbox': 'noShadows'
        };
        
        if (uiKeyMap[settingKey]) {
            finalKey = uiKeyMap[settingKey];
        }
        
        const settingItem = {
            key: finalKey, // 매핑된 키 사용
            label: label,
            value: currentValue,
            element: element,
            type: type,
            powerUserKey: finalPowerUserKey
        };
        
        // 카테고리 자동 분류 (기존 방식으로 복원)
        const parentSection = element.closest('[id*="Theme"], [id*="UI"], [id*="option"]');
        let category = 'other';
        
        if (parentSection.length > 0) {
            const parentId = parentSection.attr('id') || '';
            if (parentId.includes('Theme') || parentId.includes('theme')) {
                category = 'theme';
            } else if (parentId.includes('UI') || parentId.includes('ui')) {
                category = 'ui';
            } else if (parentId.includes('option') || parentId.includes('message') || 
                       settingKey.includes('message') || settingKey.includes('chat') ||
                       settingKey.includes('swipe') || settingKey.includes('timestamp') ||
                       settingKey.includes('timer') || settingKey.includes('hotswap') ||
                       settingKey.includes('token') || settingKey.includes('avatar')) {
                category = 'message';
            }
        }
        
        // Color picker는 테마 카테고리로 강제 분류
        if (type === 'toolcool-color-picker') {
            category = 'theme';
        }
        
        categorizedSettings[category].push(settingItem);
        //console.log(`ThemePresetManager: 설정 추가됨 - ${settingKey} (${category})`);
    });
    
    // 최종 통계 로그
    //console.log('ThemePresetManager: 처리 통계', {
        총_요소수: allElements.length,
        처리된_요소수: processedCount,
        제외된_요소수: excludedCount,
        powerUser_키_못찾음: powerUserNotFoundCount,
        숨겨진_요소_제외: hiddenExcludedCount
    });
    
    //console.log('ThemePresetManager: 카테고리별 설정 수', {
        theme: categorizedSettings.theme.length,
        ui: categorizedSettings.ui.length,
        message: categorizedSettings.message.length,
        other: categorizedSettings.other.length
    });
    
    // 7. HTML 생성 함수
    function createSettingsHTML(settingsArray, containerId) {
        const container = $(`#${containerId}`);
        container.empty();
        
        //console.log(`ThemePresetManager: ${containerId} 컨테이너에 ${settingsArray.length}개 설정 생성`);
        
        settingsArray.forEach(setting => {
            const isChecked = selectedSettings[setting.key] !== false; // 기본값이 true이므로
            const item = $(`
                <div class="setting-item">
                    <input type="checkbox" id="setting_${setting.key}" ${isChecked ? 'checked' : ''}>
                    <label for="setting_${setting.key}">${setting.label}</label>
                    <span class="setting-value">${setting.value}</span>
                </div>
            `);
            container.append(item);
            //console.log(`ThemePresetManager: 체크박스 생성됨 - setting_${setting.key} (${isChecked ? 'checked' : 'unchecked'})`);
        });
    }
    
    // 8. 각 섹션 생성
    createSettingsHTML(categorizedSettings.theme, 'ThemePresetManager_themeSettings');
    createSettingsHTML(categorizedSettings.ui, 'ThemePresetManager_uiSettings');
    createSettingsHTML(categorizedSettings.message, 'ThemePresetManager_messageSettings');
    createSettingsHTML(categorizedSettings.other, 'ThemePresetManager_otherSettings');
    
    //console.log('ThemePresetManager: 상세설정 UI 생성 완료', {
        theme: categorizedSettings.theme.length,
        ui: categorizedSettings.ui.length,
        message: categorizedSettings.message.length,
        other: categorizedSettings.other.length,
        총_설정수: Object.values(categorizedSettings).reduce((sum, arr) => sum + arr.length, 0)
    });
}

// 스마트 자동저장: 기본 설정 초기화 로직
function initializeDefaultSettingsIfNeeded() {
    //console.log('ThemePresetManager: 스마트 자동저장 - 기본 설정 초기화 시작');
    
    if (hasInitializedDefaultSettings) {
        //console.log('ThemePresetManager: 스마트 자동저장 - 이미 초기화됨, 스킵');
        return;
    }
    
    try {
        const settings = extension_settings[extensionName];
        const currentDefaultSettings = settings.defaultSelectedSettings || {};
        
        //console.log('ThemePresetManager: 스마트 자동저장 - 현재 기본 설정 상태', {
            현재_설정수: Object.keys(currentDefaultSettings).length,
            현재_설정들: Object.keys(currentDefaultSettings)
        });
        
        // DOM에서 실제 사용 가능한 설정들 스캔 (createAdvancedSettingsUI와 동일한 로직)
        const allElements = $('#user-settings-block').find('input, select, textarea, toolcool-color-picker');
        const domSettingKeys = new Set();
        
        // 중복 방지를 위한 제외 목록
        const DUPLICATE_EXCLUSIONS = [
            'themes', 'customCSS', 'background', // 하드코딩된 핵심 설정들
            'chat_width_slider_counter', 'font_scale_counter', 'blur_strength_counter', 'shadow_width_counter', // 연동된 counter들
            'chat_truncation_counter', 'streaming_fps_counter' // 연동된 counter들
        ];
        
        // 보안상 제외할 설정들
        const EXCLUDED_SETTINGS = [
            'password', 'api_key', 'token', 'secret', 'auth', 'login', 'credential',
            'openai_key', 'claude_key', 'palm_key', 'cohere_key', 'ai21_key',
            'server_urls', 'proxy', 'endpoint', 'api_url', 'base_url',
            'user_name', 'user_id', 'session', 'cookie'
        ];
        
        allElements.each(function() {
            const element = $(this);
            const id = element.attr('id');
            const name = element.attr('name');
            const type = element.attr('type') || element.prop('tagName').toLowerCase();
            const dataFor = element.attr('data-for');
            
            // data-for 속성이 있으면 보조 요소이므로 건너뛰기
            if (dataFor) {
                return;
            }
            
            if (!id && !name) {
                return;
            }
            
            const settingKey = id || name;
            
            // 제외 목록 확인
            if (DUPLICATE_EXCLUSIONS.includes(settingKey)) {
                return;
            }
            
            // 보안 제외 목록에서 예외 처리
            const isExcluded = EXCLUDED_SETTINGS.some(excluded => settingKey.toLowerCase().includes(excluded.toLowerCase()));
            if (isExcluded) {
                // 예외 처리: relaxed_api_urls는 허용
                if (settingKey !== 'relaxed_api_urls') {
                    return;
                }
            }
            
            // power_user에 해당하는 키가 있는지 확인
            const powerUserKey = findPowerUserKey(settingKey);
            if (!powerUserKey) {
                // 새로운 설정들 예외 처리
                if (settingKey === 'aux_field' || settingKey === 'background_thumbnails_animation' || 
                    settingKey === 'relaxed_api_urls' || settingKey === 'example_messages_behavior' || 
                    settingKey === 'auto-load-chat-checkbox' || settingKey === 'messageTimerEnabled' ||
                    settingKey === 'messageTimestampsEnabled' || settingKey === 'messageModelIconEnabled' ||
                    settingKey === 'mesIDDisplayEnabled' || settingKey === 'hideChatAvatarsEnabled' ||
                    settingKey === 'messageTokensEnabled' || settingKey === 'pin_styles') {
                    // 허용
                }
                // Color picker의 경우 특별 처리
                else if (type === 'toolcool-color-picker') {
                    const colorKeyMap = {
                        'main-text-color-picker': 'main_text_color',
                        'italics-color-picker': 'italics_text_color',
                        'underline-color-picker': 'underline_text_color',
                        'quote-color-picker': 'quote_text_color',
                        'shadow-color-picker': 'shadow_color',
                        'chat-tint-color-picker': 'chat_tint_color',
                        'blur-tint-color-picker': 'blur_tint_color',
                        'border-color-picker': 'border_color',
                        'user-mes-blur-tint-color-picker': 'user_mes_blur_tint_color',
                        'bot-mes-blur-tint-color-picker': 'bot_mes_blur_tint_color'
                    };
                    const mappedKey = colorKeyMap[settingKey];
                    if (!mappedKey || !power_user.hasOwnProperty(mappedKey)) {
                        return;
                    }
                } else {
                    return;
                }
            }
            
            // 숨겨진, 비활성화된, 개발자 전용 요소들 제외
            if (element.prop('disabled') || 
                element.hasClass('hidden') ||
                element.hasClass('disabled') ||
                element.attr('style')?.includes('display: none') ||
                element.attr('style')?.includes('visibility: hidden') ||
                (settingKey.includes('aux_field') && settingKey !== 'aux_field') ||
                settingKey.includes('debug') ||
                settingKey.includes('dev_') ||
                settingKey.includes('internal_') ||
                (settingKey.includes('pin_') && settingKey !== 'pin_styles') ||
                settingKey.includes('greeting_')) {
                return;
            }
            
            // 키 매핑 적용
            let finalKey = settingKey;
            
            // Color picker 키 매핑
            if (type === 'toolcool-color-picker') {
                const colorKeyMap = {
                    'main-text-color-picker': 'main_text_color',
                    'italics-color-picker': 'italics_text_color',
                    'underline-color-picker': 'underline_text_color',
                    'quote-color-picker': 'quote_text_color',
                    'shadow-color-picker': 'shadow_color',
                    'chat-tint-color-picker': 'chat_tint_color',
                    'blur-tint-color-picker': 'blur_tint_color',
                    'border-color-picker': 'border_color',
                    'user-mes-blur-tint-color-picker': 'user_mes_blur_tint_color',
                    'bot-mes-blur-tint-color-picker': 'bot_mes_blur_tint_color'
                };
                finalKey = colorKeyMap[settingKey] || settingKey;
            }
            
            // UI/레이아웃 관련 키 매핑
            const uiKeyMap = {
                'blur_strength_slider': 'blur_strength',
                'shadow_width_slider': 'shadow_width',
                'font_scale_slider': 'font_scale',
                'chat_width_slider': 'chat_width',
                'avatar_style_select': 'avatar_style',
                'chat_display_select': 'chat_display',
                'toastr_position_select': 'toastr_position',
                'fast_ui_mode_checkbox': 'fast_ui_mode',
                'waifuMode_checkbox': 'waifuMode',
                'noShadows_checkbox': 'noShadows'
            };
            
            if (uiKeyMap[finalKey]) {
                finalKey = uiKeyMap[finalKey];
            }
            
            domSettingKeys.add(finalKey);
        });
        
        // 새로운 설정들 추가
        const newSettings = ['aux_field', 'background_thumbnails_animation', 'relaxed_api_urls', 'example_messages_behavior', 'auto-load-chat-checkbox'];
        newSettings.forEach(key => domSettingKeys.add(key));
        
        //console.log('ThemePresetManager: 스마트 자동저장 - DOM에서 발견된 설정들', {
            DOM_설정수: domSettingKeys.size,
            DOM_설정들: Array.from(domSettingKeys)
        });
        
        // 누락된 설정들 찾기 및 추가 (기존값 보존)
        let addedCount = 0;
        const updatedDefaultSettings = { ...currentDefaultSettings };
        
        domSettingKeys.forEach(key => {
            if (!(key in updatedDefaultSettings)) {
                updatedDefaultSettings[key] = false; // 기본적으로 false로 설정
                addedCount++;
                //console.log(`ThemePresetManager: 스마트 자동저장 - 누락된 설정 추가: ${key} = false`);
            }
        });
        
        if (addedCount > 0) {
            settings.defaultSelectedSettings = updatedDefaultSettings;
            saveSettingsDebounced();
            //console.log('ThemePresetManager: 스마트 자동저장 - 기본 설정 업데이트 완료', {
                추가된_설정수: addedCount,
                최종_설정수: Object.keys(updatedDefaultSettings).length
            });
        } else {
            //console.log('ThemePresetManager: 스마트 자동저장 - 추가할 설정 없음');
        }
        
        hasInitializedDefaultSettings = true;
        //console.log('ThemePresetManager: 스마트 자동저장 - 초기화 완료');
        
    } catch (error) {
        console.error('ThemePresetManager: 스마트 자동저장 - 초기화 중 오류 발생', error);
        // 오류가 발생해도 플래그는 설정하여 무한 재시도 방지
        hasInitializedDefaultSettings = true;
    }
}

// 새로운 설정들의 값을 가져오는 헬퍼 함수
function getSpecialSettingValue(key) {
    try {
        switch (key) {
            case 'aux_field':
                return $('#aux_field').val() || '';
            case 'background_thumbnails_animation':
                return $('#background_thumbnails_animation').is(':checked');
            case 'relaxed_api_urls':
                return $('#relaxed_api_urls').is(':checked');
            case 'example_messages_behavior':
                return $('#example_messages_behavior').val() || 'normal';
            case 'auto-load-chat-checkbox':
                return $('#auto-load-chat-checkbox').is(':checked');
            case 'messageTimerEnabled':
                return $('#messageTimerEnabled').is(':checked');
            case 'messageTimestampsEnabled':
                return $('#messageTimestampsEnabled').is(':checked');
            case 'messageModelIconEnabled':
                return $('#messageModelIconEnabled').is(':checked');
            case 'mesIDDisplayEnabled':
                return $('#mesIDDisplayEnabled').is(':checked');
            case 'hideChatAvatarsEnabled':
                return $('#hideChatAvatarsEnabled').is(':checked');
            case 'messageTokensEnabled':
                return $('#messageTokensEnabled').is(':checked');
            case 'pin_styles':
                return $('#pin_styles').is(':checked');
            case 'background':
                return getCurrentBackground();
            default:
                return undefined;
        }
    } catch (error) {
        console.warn(`ThemePresetManager: 특별 설정 값 가져오기 실패 - ${key}:`, error);
        return undefined;
    }
}

// 새로운 설정들을 적용하는 헬퍼 함수
function applySpecialSetting(key, value) {
    try {
        switch (key) {
            case 'aux_field':
                $('#aux_field').val(value);
                break;
            case 'background_thumbnails_animation':
                $('#background_thumbnails_animation').prop('checked', Boolean(value));
                break;
            case 'relaxed_api_urls':
                $('#relaxed_api_urls').prop('checked', Boolean(value));
                break;
            case 'example_messages_behavior':
                $('#example_messages_behavior').val(value);
                break;
            case 'auto-load-chat-checkbox':
                $('#auto-load-chat-checkbox').prop('checked', Boolean(value));
                break;
            case 'messageTimerEnabled':
                $('#messageTimerEnabled').prop('checked', Boolean(value));
                break;
            case 'messageTimestampsEnabled':
                $('#messageTimestampsEnabled').prop('checked', Boolean(value));
                break;
            case 'messageModelIconEnabled':
                $('#messageModelIconEnabled').prop('checked', Boolean(value));
                break;
            case 'mesIDDisplayEnabled':
                $('#mesIDDisplayEnabled').prop('checked', Boolean(value));
                break;
            case 'hideChatAvatarsEnabled':
                $('#hideChatAvatarsEnabled').prop('checked', Boolean(value));
                break;
            case 'messageTokensEnabled':
                $('#messageTokensEnabled').prop('checked', Boolean(value));
                break;
            case 'pin_styles':
                $('#pin_styles').prop('checked', Boolean(value));
                break;
            case 'background':
                if (value && value.path) {
                    setCurrentBackground(value.path, value.style || 'classic');
                }
                break;
        }
        //console.log(`ThemePresetManager: 특별 설정 적용됨 - ${key}: ${value}`);
    } catch (error) {
        console.warn(`ThemePresetManager: 특별 설정 적용 실패 - ${key}:`, error);
    }
}

// power_user 객체에서 해당하는 키 찾기
function findPowerUserKey(settingKey) {
    // 직접 매칭 시도
    if (power_user.hasOwnProperty(settingKey)) {
        return settingKey;
    }
    
    // 특별한 매핑 테이블 (누락된 요소들을 위한)
    const specialMappings = {
        'messageTimerEnabled': 'timer_enabled',
        'messageTimestampsEnabled': 'timestamps_enabled',
        'messageModelIconEnabled': 'timestamp_model_icon',
        'mesIDDisplayEnabled': 'mesIDDisplay_enabled',
        'hideChatAvatarsEnabled': 'hideChatAvatars_enabled',
        'messageTokensEnabled': 'message_token_count_enabled',
        'pin_styles': 'pin_styles'
    };
    
    if (specialMappings[settingKey]) {
        return specialMappings[settingKey];
    }
    
    // 일반적인 변환 패턴들
    const patterns = [
        settingKey.replace(/-/g, '_'), // kebab-case to snake_case
        settingKey.replace(/_/g, ''), // snake_case to camelCase 준비
        settingKey.replace(/([A-Z])/g, '_$1').toLowerCase(), // camelCase to snake_case
        settingKey.replace(/checkbox$/i, '').replace(/enabled$/i, ''), // 접미사 제거
        settingKey.replace(/^(message|chat|user|power)_?/i, '') // 접두사 제거
    ];
    
    for (const pattern of patterns) {
        if (power_user.hasOwnProperty(pattern)) {
            return pattern;
        }
    }
    
    // 부분 매칭 시도 (주의깊게)
    const powerUserKeys = Object.keys(power_user);
    for (const key of powerUserKeys) {
        if (key.includes(settingKey) || settingKey.includes(key)) {
            return key;
        }
    }
    
    return null;
}

// 상세설정에서 선택된 설정들 저장
function saveSelectedSettings() {
    //console.log('ThemePresetManager: 선택된 설정 임시 저장 시작');
    
    const selectedSettings = {};
    
    // 동적으로 모든 설정 체크박스 찾아서 처리
    $('.setting-item input[type="checkbox"]').each(function() {
        const checkbox = $(this);
        const key = checkbox.attr('id').replace('setting_', '');
        selectedSettings[key] = checkbox.is(':checked');
    });
    
    // 임시 변수에만 저장 (영구 저장하지 않음)
    currentSelectedSettings = selectedSettings;
    //console.log('ThemePresetManager: 선택된 설정 임시 저장 완료', selectedSettings);
}



// 기본 설정을 UI에 로드
function loadDefaultSettingsToUI() {
    //console.log('ThemePresetManager: 기본 설정을 UI에 로드 시작');
    
    const settings = extension_settings[extensionName];
    const defaultSettings = settings.defaultSelectedSettings || defaultSelectedSettings;
    
    let loadedCount = 0;
    // 모든 체크박스를 기본 설정에 맞게 설정
    $('.setting-item input[type="checkbox"]').each(function() {
        const checkbox = $(this);
        const key = checkbox.attr('id').replace('setting_', '');
        const shouldBeChecked = defaultSettings[key] !== false;
        checkbox.prop('checked', shouldBeChecked);
        if (shouldBeChecked) loadedCount++;
    });
    
    //console.log('ThemePresetManager: 기본 설정을 UI에 로드 완료', { loadedCount, defaultSettings });
}

// 기본 설정 모드 토글 (단순히 기본 설정을 UI에 로드)
function toggleDefaultSettingsMode() {
    loadDefaultSettingsToUI();
    toastr.info('기본 옵션이 UI에 로드되었습니다. 원하는 설정을 선택한 후 "현재 선택을 기본으로 저장" 버튼을 클릭하세요.');
}

// 현재 선택을 기본으로 저장
function saveCurrentSelectionAsDefault() {
    const settings = extension_settings[extensionName];
    const defaultSettings = {};
    
    // 현재 체크된 모든 설정을 기본 설정으로 저장
    $('.setting-item input[type="checkbox"]').each(function() {
        const checkbox = $(this);
        const key = checkbox.attr('id').replace('setting_', '');
        defaultSettings[key] = checkbox.is(':checked');
    });
    
    settings.defaultSelectedSettings = defaultSettings;
    saveSettingsDebounced();
    
    //console.log('ThemePresetManager: 현재 선택을 기본으로 저장 완료', defaultSettings);
    toastr.success('현재 선택된 설정들이 기본 옵션으로 저장되었습니다.');
}

// 기본 설정만 선택
function selectDefaultSettingsOnly() {
    const settings = extension_settings[extensionName];
    const defaultSettings = settings.defaultSelectedSettings || defaultSelectedSettings;
    
    //console.log('ThemePresetManager: 기본 설정만 선택 시작', defaultSettings);
    
    // 모든 체크박스 해제
    $('.setting-item input[type="checkbox"]').prop('checked', false);
    //console.log('ThemePresetManager: 모든 체크박스 해제 완료');
    
    // 실제로 존재하는 체크박스들 확인
    const existingCheckboxes = $('.setting-item input[type="checkbox"]');
    const existingKeys = existingCheckboxes.map(function() {
        return $(this).attr('id').replace('setting_', '');
    }).get();
    
    //console.log('ThemePresetManager: 실제 존재하는 체크박스들', existingKeys);
    
    let selectedCount = 0;
    let notFoundCount = 0;
    const notFoundKeys = [];
    const selectedKeys = [];
    
    // defaultSelectedSettings에서 실제 존재하는 체크박스만 처리
    Object.keys(defaultSettings).forEach(key => {
        if (defaultSettings[key]) { // true인 설정만
            const checkbox = $(`#setting_${key}`);
            if (checkbox.length > 0) {
                checkbox.prop('checked', true);
                selectedCount++;
                selectedKeys.push(key);
                //console.log(`ThemePresetManager: 체크박스 선택됨 - setting_${key}`);
            } else {
                console.warn(`ThemePresetManager: 체크박스를 찾을 수 없음 - setting_${key} (UI에 생성되지 않음)`);
                notFoundCount++;
                notFoundKeys.push(key);
            }
        }
    });
    
    // 임시 저장
    saveSelectedSettings();
    
    //console.log('ThemePresetManager: 기본 설정만 선택 완료', { 
        selectedCount, 
        notFoundCount, 
        selectedKeys,
        notFoundKeys,
        defaultSettings 
    });
    
    if (notFoundCount > 0) {
        console.warn(`ThemePresetManager: ${notFoundCount}개 설정이 UI에 생성되지 않아 선택할 수 없음`, notFoundKeys);
    }
    
    toastr.success(`기본 옵션만 선택되었습니다. (${selectedCount}개 설정 선택됨${notFoundCount > 0 ? `, ${notFoundCount}개 누락` : ''})`);
}

// 현재 선택된 옵션 보기
function showCurrentSelectedOptions() {
    const settings = extension_settings[extensionName];
    const isAdvancedPanelOpen = $("#ThemePresetManager_advancedPanel").is(":visible");
    
    let selectedSettings;
    let message;
    
    if (isAdvancedPanelOpen) {
        // 상세설정 패널이 열려있으면 현재 선택된 설정들
        selectedSettings = {};
        $('.setting-item input[type="checkbox"]:checked').each(function() {
            const key = $(this).attr('id').replace('setting_', '');
            selectedSettings[key] = true;
        });
        message = "상세설정 패널에서 선택된 설정들:";
    } else {
        // 상세설정 패널이 닫혀있으면 기본 설정들
        if (settings.useDefaultSettingsOnly) {
            selectedSettings = settings.defaultSelectedSettings || defaultSelectedSettings;
            message = "기본 옵션으로 설정된 것들 (실제 저장될 설정들):";
        } else {
            message = "모든 설정이 저장됩니다 (기본 옵션이 비활성화됨):";
            selectedSettings = {};
            $('.setting-item input[type="checkbox"]').each(function() {
                const key = $(this).attr('id').replace('setting_', '');
                selectedSettings[key] = true;
            });
        }
    }
    
    const selectedCount = Object.keys(selectedSettings).filter(key => selectedSettings[key]).length;
    const totalCount = $('.setting-item input[type="checkbox"]').length;
    
    //console.log(message, selectedSettings);
    toastr.info(`${message}\n선택된 설정: ${selectedCount}/${totalCount}개\n자세한 내용은 콘솔을 확인하세요.`);
}

// 설정 삭제 함수들
async function deleteAllSettings() {
    //console.log('ThemePresetManager: 모든 설정 삭제 시작');
    
    if (!confirm('모든 저장된 테마 설정을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
        //console.log('ThemePresetManager: 모든 설정 삭제 취소됨');
        return;
    }
    
    const settings = extension_settings[extensionName];
    
    // 1. extension_settings에서 모든 데이터 삭제
    settings.chatThemes = {};
    settings.characterThemes = {};
    settings.autoSaveSlot = null;
    settings.defaultSelectedSettings = { ...defaultSelectedSettings };
    
    // 임시 selectedSettings 초기화
    currentSelectedSettings = null;
    //console.log('ThemePresetManager: currentSelectedSettings 초기화됨 (삭제 후)');
    
    // 2. 현재 채팅에서 확장 데이터 삭제
    if (chat_metadata && chat_metadata.extensions && chat_metadata.extensions[extensionName]) {
        delete chat_metadata.extensions[extensionName];
        saveChatDebounced();
        //console.log('ThemePresetManager: 현재 채팅에서 확장 데이터 삭제됨');
    }
    
    // 3. 모든 로드된 캐릭터에서 확장 데이터 삭제
    const characterDeletePromises = [];
    Object.values(characters).forEach(character => {
        if (character.data && character.data.extensions && character.data.extensions[extensionName]) {
            delete character.data.extensions[extensionName];
            //console.log(`ThemePresetManager: 캐릭터 ${character.name}에서 확장 데이터 삭제됨`);
            
            // 서버에 변경사항 저장
            const promise = fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: {
                        extensions: {
                            [extensionName]: null // null로 설정하여 삭제
                        }
                    }
                })
            }).catch(error => {
                console.error(`ThemePresetManager: 캐릭터 ${character.name} 데이터 삭제 중 오류`, error);
            });
            characterDeletePromises.push(promise);
        }
    });
    
    // 4. 모든 캐릭터 삭제 요청 완료 대기
    if (characterDeletePromises.length > 0) {
        try {
            await Promise.all(characterDeletePromises);
            //console.log(`ThemePresetManager: ${characterDeletePromises.length}개 캐릭터에서 확장 데이터 삭제 완료`);
        } catch (error) {
            console.error('ThemePresetManager: 캐릭터 데이터 삭제 중 오류', error);
        }
    }
    
    // 5. 모든 채팅 파일에서 확장 데이터 삭제 시도
    try {
        // 채팅 목록을 가져와서 각 채팅에서 확장 데이터 삭제
        const chatList = await fetch('/api/chats/list', {
            method: 'GET',
            headers: getRequestHeaders()
        });
        
        if (chatList.ok) {
            const chats = await chatList.json();
            const chatDeletePromises = [];
            
            chats.forEach(chat => {
                const promise = fetch(`/api/chats/${chat.name}/metadata`, {
                    method: 'GET',
                    headers: getRequestHeaders()
                }).then(response => {
                    if (response.ok) {
                        return response.json();
                    }
                    throw new Error(`채팅 ${chat.name} 메타데이터 로드 실패`);
                }).then(metadata => {
                    if (metadata.extensions && metadata.extensions[extensionName]) {
                        delete metadata.extensions[extensionName];
                        
                        // 수정된 메타데이터 저장
                        return fetch(`/api/chats/${chat.name}/metadata`, {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify(metadata)
                        });
                    }
                }).catch(error => {
                    console.warn(`ThemePresetManager: 채팅 ${chat.name}에서 확장 데이터 삭제 실패`, error);
                });
                
                chatDeletePromises.push(promise);
            });
            
            if (chatDeletePromises.length > 0) {
                await Promise.all(chatDeletePromises);
                //console.log(`ThemePresetManager: ${chatDeletePromises.length}개 채팅에서 확장 데이터 삭제 시도 완료`);
            }
        }
    } catch (error) {
        console.warn('ThemePresetManager: 채팅 목록 가져오기 실패', error);
    }
    
    // 6. 설정 저장 및 UI 업데이트
    saveSettingsDebounced();
    updateCurrentStatus();
    
    //console.log('ThemePresetManager: 모든 설정 삭제 완료 - 페이지 새로고침 예정');
    toastr.success('모든 테마 설정이 완전히 삭제되었습니다. 페이지가 새로고침됩니다.');
    
    // 페이지 새로고침으로 완전한 초기화
    setTimeout(() => {
        location.reload();
    }, 1000);
}

function deleteChatSettings() {
    //console.log('ThemePresetManager: 채팅 설정 삭제 시작');
    
    currentChatId = getCurrentChatId();
    if (!currentChatId) {
        toastr.error('삭제할 채팅이 선택되지 않았습니다.');
        return;
    }
    
    const settings = extension_settings[extensionName];
    if (settings.chatThemes && settings.chatThemes[currentChatId]) {
        if (confirm(`이 채팅의 테마 설정을 삭제하시겠습니까?`)) {
            delete settings.chatThemes[currentChatId];
            saveSettingsDebounced();
            updateCurrentStatus();
            
            //console.log('ThemePresetManager: 채팅 설정 삭제 완료', currentChatId);
            toastr.success('채팅 테마 설정이 삭제되었습니다.');
        }
    } else {
        toastr.error('이 채팅에 저장된 테마가 없습니다.');
    }
}

function deleteCharacterSettings() {
    //console.log('ThemePresetManager: 캐릭터 설정 삭제 시작');
    
    currentCharacterId = getCurrentCharacterId();
    if (!currentCharacterId) {
        toastr.error('삭제할 캐릭터가 선택되지 않았습니다.');
        return;
    }
    
    const settings = extension_settings[extensionName];
    if (settings.characterThemes && settings.characterThemes[currentCharacterId]) {
        if (confirm(`이 캐릭터의 테마 설정을 삭제하시겠습니까?`)) {
            delete settings.characterThemes[currentCharacterId];
            saveSettingsDebounced();
            updateCurrentStatus();
            
            //console.log('ThemePresetManager: 캐릭터 설정 삭제 완료', currentCharacterId);
            toastr.success('캐릭터 테마 설정이 삭제되었습니다.');
        }
    } else {
        toastr.error('이 캐릭터에 저장된 테마가 없습니다.');
    }
}

// 이벤트 핸들러들
function onEnabledChange(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].enabled = value;
    saveSettingsDebounced();
    //console.log('ThemePresetManager: 활성화 상태 변경', value);
}

function onAutoApplyChange(event) {
    const value = Boolean($(event.target).prop("checked"));
    extension_settings[extensionName].autoApply = value;
    saveSettingsDebounced();
    //console.log('ThemePresetManager: 자동 적용 설정 변경', value);
}

function onCheckCurrentSettings() {
    const current = getCurrentThemeAndSettings();
    const themeCount = Object.keys(current.theme).length;
    const settingsCount = Object.keys(current.settings).length;
    
    //console.log('ThemePresetManager: 현재 UI 상태 확인', current);
    toastr.info(`현재 UI 상태가 콘솔에 출력되었습니다. (${themeCount}개 테마 + ${settingsCount}개 설정)`);
}

function onCheckSavedSettings() {
    const settings = extension_settings[extensionName];
    console.log('ThemePresetManager: 전체 저장된 테마 목록 확인', settings);
    
    let totalChatThemes = 0;
    let totalCharacterThemes = 0;
    
    // 저장된 테마들의 내용 확인
    if (settings.chatThemes && Object.keys(settings.chatThemes).length > 0) {
        console.log('=== 저장된 채팅 테마들 ===');
        Object.keys(settings.chatThemes).forEach(chatId => {
            const theme = settings.chatThemes[chatId];
            totalChatThemes++;
            console.log(`\n채팅 ID: ${chatId}`);
            console.log(`저장시간: ${new Date(theme.timestamp).toLocaleString()}`);
            console.log(`테마 설정: ${Object.keys(theme.theme).length}개`);
            console.log(`사용자 설정: ${Object.keys(theme.settings).length}개`);
            console.log('테마 설정:', theme.theme);
            console.log('사용자 설정:', theme.settings);
        });
    }
    
    if (settings.characterThemes && Object.keys(settings.characterThemes).length > 0) {
        console.log('\n=== 저장된 캐릭터 테마들 ===');
        Object.keys(settings.characterThemes).forEach(characterId => {
            const theme = settings.characterThemes[characterId];
            totalCharacterThemes++;
            console.log(`\n캐릭터 ID: ${characterId}`);
            console.log(`저장시간: ${new Date(theme.timestamp).toLocaleString()}`);
            console.log(`테마 설정: ${Object.keys(theme.theme).length}개`);
            console.log(`사용자 설정: ${Object.keys(theme.settings).length}개`);
            console.log('테마 설정:', theme.theme);
            console.log('사용자 설정:', theme.settings);
        });
    }
    
    if (totalChatThemes === 0 && totalCharacterThemes === 0) {
        //console.log('저장된 테마가 없습니다.');
        toastr.info('저장된 테마가 없습니다.');
    } else {
        toastr.info(`전체 저장된 테마 목록이 콘솔에 출력되었습니다. (채팅: ${totalChatThemes}개, 캐릭터: ${totalCharacterThemes}개)`);
    }
}

async function onSaveToChat() {
    currentChatId = getCurrentChatId();
    
    if (!currentChatId) {
        toastr.error('저장할 채팅이 선택되지 않았습니다.');
        return;
    }
    
    const saved = await saveTheme('chat', currentChatId);
    if (saved) {
        toastr.success('채팅 테마가 저장되었습니다.');
    }
}

async function onSaveToCharacter() {
    currentCharacterId = getCurrentCharacterId();
    
    //console.log('ThemePresetManager: 캐릭터 저장 시도', { currentCharacterId });
    
    if (!currentCharacterId) {
        toastr.error('저장할 캐릭터가 선택되지 않았습니다. 현재 선택된 캐릭터를 확인해주세요.');
        return;
    }
    
    const saved = await saveTheme('character', currentCharacterId);
    if (saved) {
        toastr.success('캐릭터 테마가 저장되었습니다.');
    }
}

function onLoadFromChat() {
    currentChatId = getCurrentChatId();
    
    if (!currentChatId) {
        toastr.error('로드할 채팅이 선택되지 않았습니다.');
        return;
    }
    
    loadTheme('chat', currentChatId);
}

function onLoadFromCharacter() {
    currentCharacterId = getCurrentCharacterId();
    
    if (!currentCharacterId) {
        toastr.error('로드할 캐릭터가 선택되지 않았습니다.');
        return;
    }
    
    loadTheme('character', currentCharacterId);
}

function onExportSettings() {
    exportSettings();
    toastr.success('설정이 내보내졌습니다.');
}

function onImportSettings() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = function(e) {
        const file = e.target.files[0];
        if (file) {
            importSettings(file);
        }
    };
    input.click();
}

async function onDeleteAllSettings() {
    await deleteAllSettings();
}

function onDeleteChatSettings() {
    deleteChatSettings();
}

function onDeleteCharacterSettings() {
    deleteCharacterSettings();
}

// 상세설정 관련 이벤트 핸들러들
function onShowAdvancedSettings() {
    const panel = $("#ThemePresetManager_advancedPanel");
    const saveInfo = $("#ThemePresetManager_saveInfo");
    
    if (panel.is(":visible")) {
        panel.hide();
        $("#ThemePresetManager_showAdvanced").text("상세설정");
        saveInfo.html('💡 <strong>저장 방식:</strong> 상세설정 패널이 열려있으면 선택된 설정만, 닫혀있으면 모든 설정이 저장됩니다.');
        //console.log('ThemePresetManager: 상세설정 패널 닫힘');
    } else {
        // 상세설정 패널 열기
        panel.show();
        $("#ThemePresetManager_showAdvanced").text("상세설정 숨기기");
        //console.log('ThemePresetManager: 상세설정 패널 열림 - 최신 상태로 UI 생성 시작');
        
        // 스마트 자동저장: 기본 설정 초기화 먼저 실행
        initializeDefaultSettingsIfNeeded();
        
        // 항상 UI를 먼저 생성
        createAdvancedSettingsUI();
        
        // currentSelectedSettings가 없으면 기본옵션 적용
        if (!currentSelectedSettings) {
            //console.log('ThemePresetManager: currentSelectedSettings가 없어 기본옵션 적용');
            // UI 생성 후 기본값 설정
            setTimeout(() => {
                selectDefaultSettingsOnly();
            }, 100);
        } else {
            //console.log('ThemePresetManager: 기존 currentSelectedSettings 사용', currentSelectedSettings);
        }
        
        saveInfo.html('💡 <strong>저장 방식:</strong> <span style="color: #4CAF50;">상세설정 패널이 열려있어 선택된 설정만 저장됩니다.</span>');
        //console.log('ThemePresetManager: 상세설정 패널 열림 - 임시 설정 모드', {
            hasCurrentSelected: !!currentSelectedSettings
        });
    }
}

function onSelectAllSettings() {
    $('.setting-item input[type="checkbox"]').prop('checked', true);
    saveSelectedSettings();
    toastr.success('모든 설정이 선택되었습니다.');
}

function onDeselectAllSettings() {
    $('.setting-item input[type="checkbox"]').prop('checked', false);
    saveSelectedSettings();
    toastr.success('모든 설정이 해제되었습니다.');
}

function onResetToDefaultSettings() {
    const settings = extension_settings[extensionName];
    settings.defaultSelectedSettings = { ...defaultSelectedSettings };
    
    // 임시 selectedSettings 초기화
    currentSelectedSettings = null;
    //console.log('ThemePresetManager: 설정을 기본값으로 초기화 - currentSelectedSettings 초기화됨');
    
    saveSettingsDebounced();
    createAdvancedSettingsUI();
    toastr.success('설정이 기본값으로 초기화되었습니다.');
    //console.log('ThemePresetManager: 설정을 기본값으로 초기화', defaultSelectedSettings);
}

// 새로운 기본 설정 관련 이벤트 핸들러들
function onToggleDefaultSettingsMode() {
    toggleDefaultSettingsMode();
}

function onSaveAsDefault() {
    saveCurrentSelectionAsDefault();
}

function onSelectDefaultSettingsOnly() {
    selectDefaultSettingsOnly();
}

function onShowCurrentSelectedOptions() {
    showCurrentSelectedOptions();
}

function onUseDefaultSettingsOnlyChange(event) {
    // 기본옵션 사용 기능 완전 중단 (스마트 자동저장으로 대체)
    //toastr.warning('이 기능은 스마트 자동저장으로 대체되어 더 이상 사용되지 않습니다.');
    //console.log('ThemePresetManager: 기본옵션 사용 기능 중단됨 - 스마트 자동저장으로 대체');
    return;
}

function onRestoreFromAutoSlot() {
    restoreFromAutoSlot();
}

function onDeleteAutoSlot() {
    const settings = extension_settings[extensionName];
    if (!settings.autoSaveSlot) {
        toastr.error('자동 저장 슬롯에 저장된 설정이 없습니다.');
        return;
    }
    
    const savedTime = new Date(settings.autoSaveSlot.timestamp).toLocaleString();
    const themeCount = Object.keys(settings.autoSaveSlot.theme).length;
    const settingsCount = Object.keys(settings.autoSaveSlot.settings).length;
    
    const confirmMessage = `자동 저장 슬롯을 삭제하시겠습니까?\n\n저장시간: ${savedTime}\n테마: ${themeCount}개\n설정: ${settingsCount}개\n\n이 작업은 되돌릴 수 없습니다.`;
    
    if (confirm(confirmMessage)) {
        deleteAutoSlot();
    }
}

function onOverwriteAutoSlot() {
    const settings = extension_settings[extensionName];
    
    if (settings.autoSaveSlot) {
        const savedTime = new Date(settings.autoSaveSlot.timestamp).toLocaleString();
        const themeCount = Object.keys(settings.autoSaveSlot.theme).length;
        const settingsCount = Object.keys(settings.autoSaveSlot.settings).length;
        
        const confirmMessage = `자동 저장 슬롯을 현재 설정으로 덮어쓰시겠습니까?\n\n기존 저장시간: ${savedTime}\n기존 테마: ${themeCount}개\n기존 설정: ${settingsCount}개\n\n현재 모든 설정이 전체선택 사양으로 저장됩니다.`;
        
        if (confirm(confirmMessage)) {
            overwriteAutoSlot();
        }
    } else {
        // 자동 저장 슬롯이 없으면 바로 저장
        overwriteAutoSlot();
    }
}

// 현재 설정으로 동기화 함수
function onSyncCurrentSettings() {
    //console.log('ThemePresetManager: 현재 설정으로 동기화 시작');
    
    if (!$("#ThemePresetManager_advancedPanel").is(":visible")) {
        console.warn('ThemePresetManager: 상세설정 패널이 닫혀있어 동기화를 건너뜀');
        return;
    }
    
    //console.log('ThemePresetManager: 상세설정 UI를 최신 상태로 재생성');
    createAdvancedSettingsUI();
    
    // 동기화 완료 메시지
    toastr.success('현재 설정으로 동기화되었습니다.');
    //console.log('ThemePresetManager: 현재 설정으로 동기화 완료');
}

// 배경 관련 함수들
function getCurrentBackground() {
    //console.log('ThemePresetManager: 정확한 배경 정보 수집 시작');
    
    // 1. 채팅 전용 배경 우선 확인 (가장 높은 우선순위)
    const chatSpecificBackgroundUrl = chat_metadata['custom_background'];
    //console.log('ThemePresetManager: 채팅 전용 배경 URL 확인', chatSpecificBackgroundUrl);
    
    if (chatSpecificBackgroundUrl) {
        const pathMatch = chatSpecificBackgroundUrl.match(/url\("(.+?)"\)/);
        if (pathMatch && pathMatch[1]) {
            const rawPath = decodeURIComponent(pathMatch[1]);
            const normalizedPath = normalizeBackgroundPath(rawPath);
            
            if (normalizedPath) {
                const bg = {
                    path: normalizedPath,
                    style: background_settings.fitting || 'classic',
                    isChatSpecific: true,
                    isLocked: true // 캐릭터 잠금 상태임을 명시
                };
                //console.log('ThemePresetManager: 채팅 전용 배경 정보 발견 (정규화됨)', bg);
                return bg;
            }
        }
    }
    
    // 2. 시스템 기본 배경 확인
    //console.log('ThemePresetManager: background_settings 객체 확인', background_settings);
    if (background_settings && background_settings.name) {
        const normalizedPath = normalizeBackgroundPath(background_settings.name);
        
        if (normalizedPath) {
            const bg = {
                path: normalizedPath,
                style: background_settings.fitting || 'classic',
                isChatSpecific: false,
                isLocked: false // 시스템 배경은 잠금 상태가 아님
            };
            //console.log('ThemePresetManager: 시스템 기본 배경 정보 발견 (정규화됨)', bg);
            return bg;
        }
    }
    
    // 3. DOM에서 직접 확인 (fallback)
    try {
        const bgElement = $('#bg1, #bg_custom');
        const backgroundImage = bgElement.css('background-image');
        
        if (backgroundImage && backgroundImage !== 'none') {
            const match = backgroundImage.match(/backgrounds\/([^"]+)/);
            if (match) {
                const rawPath = decodeURIComponent(match[1]);
                const normalizedPath = normalizeBackgroundPath(rawPath);
                
                if (normalizedPath) {
                    const fitting = $('#background_fitting').val() || 'classic';
                    
                    const bg = {
                        path: normalizedPath,
                        style: fitting,
                        isChatSpecific: false,
                        isLocked: false // DOM에서 읽은 배경도 잠금 상태가 아님
                    };
                    //console.log('ThemePresetManager: DOM에서 읽은 배경 정보 (정규화됨)', bg);
                    return bg;
                }
            }
        }
    } catch (error) {
        console.warn('ThemePresetManager: DOM에서 배경 정보 읽기 실패', error);
    }
    
    console.warn('ThemePresetManager: 배경 정보를 찾을 수 없습니다.');
    return null;
}

function setCurrentBackground(imagePath, style = 'classic', lockBackground = false) {
    if (!imagePath) {
        console.error('ThemePresetManager: 배경으로 설정할 이미지 경로가 필요합니다.');
        return;
    }
    //console.log(`ThemePresetManager: 배경 변경 시작`, { imagePath, style, lockBackground });

    // 경로 정규화
    const normalizedPath = normalizeBackgroundPath(imagePath);
    if (!normalizedPath) {
        console.error('ThemePresetManager: 배경 경로 정규화 실패', imagePath);
        return;
    }
    
    //console.log('ThemePresetManager: 정규화된 배경 경로', { original: imagePath, normalized: normalizedPath });

    // 배경 URL 생성 (안전한 방식)
    let url;
    try {
        // backgrounds/ 접두사 제거하고 파일명만 추출
        const fileName = normalizedPath.startsWith('backgrounds/') 
            ? normalizedPath.substring(11) 
            : normalizedPath;
        
        // 파일명을 안전하게 인코딩
        const encodedFileName = encodeURIComponent(fileName);
        url = `url("backgrounds/${encodedFileName}")`;
        
        //console.log('ThemePresetManager: 배경 URL 생성 성공', { 
            fileName, 
            encodedFileName, 
            url,
            isEncoded: fileName !== encodedFileName
        });
    } catch (error) {
        console.error('ThemePresetManager: 배경 URL 생성 실패', error);
        return;
    }
    
    if (lockBackground) {
        // 1. 캐릭터 잠금 배경으로 설정 (기존 방식)
        chat_metadata['custom_background'] = url;
        //console.log('ThemePresetManager: 캐릭터 잠금 배경 설정됨', url);
    } else {
        // 2. 잠금 없이 배경만 변경 (새로운 방식)
        // custom_background는 설정하지 않고 직접 배경만 변경
        //console.log('ThemePresetManager: 잠금 없이 배경만 변경', url);
        
        // 직접 배경 요소에 적용
        $('#bg_custom').css('background-image', url);
    }
    
    // 3. 시스템 배경은 건드리지 않음 (전체 배경 변경 방지)
    //console.log('ThemePresetManager: 시스템 배경은 변경하지 않음 (캐릭터별 배경만 적용)');
    
    // 4. FORCE_SET_BACKGROUND 이벤트를 발생시켜 배경 변경을 요청합니다.
    eventSource.emit(event_types.FORCE_SET_BACKGROUND, { url: url, path: normalizedPath });
    
    // 5. 배경 스타일(fitting) 설정
    if (style && style !== 'classic') {
        // setFittingClass 함수 직접 구현
        const backgrounds = $('#bg1, #bg_custom');
        for (const option of ['cover', 'contain', 'stretch', 'center']) {
            backgrounds.toggleClass(option, option === style);
        }
        
        $('#background_fitting').val(style);
    }
    
    // 6. 설정 저장
    saveSettingsDebounced();
    
    //console.log('ThemePresetManager: 배경 변경 완료', { 
        originalPath: imagePath, 
        normalizedPath: normalizedPath, 
        finalUrl: url,
        style: style,
        lockBackground: lockBackground
    });
}

// 배경 경로 정규화 함수
function normalizeBackgroundPath(path) {
    if (!path) {
        console.warn('ThemePresetManager: normalizeBackgroundPath - 빈 경로 입력');
        return null;
    }
    
    //console.log('ThemePresetManager: 배경 경로 정규화 시작', { originalPath: path });
    
    // URL 디코딩
    let normalizedPath = decodeURIComponent(path);
    
    // 중복 슬래시 제거 (/// -> /)
    normalizedPath = normalizedPath.replace(/\/+/g, '/');
    
    // backgrounds/ 중복 제거
    if (normalizedPath.startsWith('backgrounds/backgrounds/')) {
        normalizedPath = normalizedPath.replace('backgrounds/backgrounds/', 'backgrounds/');
        //console.log('ThemePresetManager: 중복 backgrounds/ 제거됨', { before: path, after: normalizedPath });
    }
    
    // backgrounds/로 시작하지 않으면 추가
    if (!normalizedPath.startsWith('backgrounds/')) {
        normalizedPath = `backgrounds/${normalizedPath}`;
        //console.log('ThemePresetManager: backgrounds/ 접두사 추가됨', { before: path, after: normalizedPath });
    }
    
    // 파일명에 .jpg가 중복으로 붙은 경우 제거
    if (normalizedPath.match(/\.jpg\.jpg$/)) {
        normalizedPath = normalizedPath.replace(/\.jpg\.jpg$/, '.jpg');
        //console.log('ThemePresetManager: 중복 .jpg 확장자 제거됨', { before: path, after: normalizedPath });
    }
    
    //console.log('ThemePresetManager: 배경 경로 정규화 완료', { 
        originalPath: path, 
        normalizedPath: normalizedPath,
        isChanged: path !== normalizedPath
    });
    
    return normalizedPath;
}

// 메인 초기화 함수
jQuery(async () => {
    //console.log('ThemePresetManager: 확장 로드 시작');
    
    // 이것은 파일에서 HTML을 로드하는 ExtStQRControl입니다.
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);

    // settingsHtml을 extensions_settings에 추가합니다.
    // extension_settings는 설정 메뉴의 왼쪽열, extensions_settings2는 설정 메뉴의 오른쪽 열입니다.
    // 왼쪽은 시스템 기능을 다루는 확장 프로그램이어야 하고, 오른쪽은 시각/UI 관련이어야 합니다.
    $("#extensions_settings").append(settingsHtml);

    // 이벤트 리스너 등록
    $("#ThemePresetManager_enabled").on("input", onEnabledChange);
    $("#ThemePresetManager_autoApply").on("input", onAutoApplyChange);
    
    $("#ThemePresetManager_checkCurrent").on("click", onCheckCurrentSettings);
    $("#ThemePresetManager_checkSaved").on("click", onCheckSavedSettings);
    
    // 디버그용: 현재 배경 정보 확인 (개발 중에만 사용)
    //console.log('ThemePresetManager: 현재 배경 정보 확인', getCurrentBackground());
    $("#ThemePresetManager_saveToChat").on("click", onSaveToChat);
    $("#ThemePresetManager_saveToCharacter").on("click", onSaveToCharacter);
    $("#ThemePresetManager_loadFromChat").on("click", onLoadFromChat);
    $("#ThemePresetManager_loadFromCharacter").on("click", onLoadFromCharacter);
    $("#ThemePresetManager_restoreFromAutoSlot").on("click", onRestoreFromAutoSlot);
    $("#ThemePresetManager_overwriteAutoSlot").on("click", onOverwriteAutoSlot);
    $("#ThemePresetManager_deleteAutoSlot").on("click", onDeleteAutoSlot);
    $("#ThemePresetManager_export").on("click", onExportSettings);
    $("#ThemePresetManager_import").on("click", onImportSettings);
    $("#ThemePresetManager_exportCharacter").on("click", onExportCharacterSettings);
    $("#ThemePresetManager_exportChat").on("click", onExportChatSettings);
    $("#ThemePresetManager_importSpecific").on("click", onImportSpecificSettings);
    $("#ThemePresetManager_deleteAll").on("click", onDeleteAllSettings);
    $("#ThemePresetManager_deleteChat").on("click", onDeleteChatSettings);
    $("#ThemePresetManager_deleteCharacter").on("click", onDeleteCharacterSettings);
    
    // 상세설정 관련 이벤트 리스너
    $("#ThemePresetManager_showAdvanced").on("click", onShowAdvancedSettings);
    $("#ThemePresetManager_selectAll").on("click", onSelectAllSettings);
    $("#ThemePresetManager_deselectAll").on("click", onDeselectAllSettings);
    $("#ThemePresetManager_selectDefaultOnly").on("click", onSelectDefaultSettingsOnly);
    $("#ThemePresetManager_resetToDefault").on("click", onResetToDefaultSettings);
    // $("#ThemePresetManager_defaultSettingsMode").on("click", onToggleDefaultSettingsMode); // 일시적으로 비활성화
    $("#ThemePresetManager_showCurrentOptions").on("click", onShowCurrentSelectedOptions);
    $("#ThemePresetManager_saveAsDefault").on("click", onSaveAsDefault);
    $("#ThemePresetManager_useDefaultSettingsOnly").on("input", onUseDefaultSettingsOnlyChange);
    $("#ThemePresetManager_syncCurrentSettings").on("click", onSyncCurrentSettings);
    
    // 상세설정 체크박스 변경 이벤트
    $(document).on('change', '.setting-item input[type="checkbox"]', function() {
        saveSelectedSettings();
        
        // 상세설정 패널이 열려있으면 저장 정보 메시지 업데이트
        if ($("#ThemePresetManager_advancedPanel").is(":visible")) {
            const checkedCount = $('.setting-item input[type="checkbox"]:checked').length;
            const totalCount = $('.setting-item input[type="checkbox"]').length;
            $("#ThemePresetManager_saveInfo").html(`💡 <strong>저장 방식:</strong> <span style="color: #4CAF50;">상세설정 패널이 열려있어 선택된 ${checkedCount}/${totalCount}개 설정만 저장됩니다.</span>`);
        }
    });
    
    // 설정 로드
    await loadSettings();
    
    // 현재 ID 초기화
    currentChatId = getCurrentChatId();
    currentCharacterId = getCurrentCharacterId();
    
    // SillyTavern 내장 이벤트 시스템 사용
    // 채팅 변경 이벤트
    eventSource.on(event_types.CHAT_CHANGED, function(chatId) {
        //console.log('ThemePresetManager: 채팅 변경 감지 (내장 이벤트)', chatId);
        setTimeout(() => {
            updateCurrentStatus();
            if (extension_settings[extensionName].autoApply) {
                autoApplyThemeWithSave();
            }
            
            // 상세설정 패널이 열려있으면 실시간 업데이트
            if ($("#ThemePresetManager_advancedPanel").is(":visible")) {
                //console.log('ThemePresetManager: 상세설정 패널이 열려있어 실시간 업데이트 실행');
                createAdvancedSettingsUI();
            }
        }, 100);
    });
    
    // 새 채팅 생성 이벤트
    eventSource.on(event_types.CHAT_CREATED, function() {
        //console.log('ThemePresetManager: 새 채팅 생성 감지 (내장 이벤트)');
        setTimeout(() => {
            updateCurrentStatus();
            if (extension_settings[extensionName].autoApply) {
                autoApplyThemeWithSave();
            }
            
            // 상세설정 패널이 열려있으면 실시간 업데이트
            if ($("#ThemePresetManager_advancedPanel").is(":visible")) {
                //console.log('ThemePresetManager: 상세설정 패널이 열려있어 실시간 업데이트 실행');
                createAdvancedSettingsUI();
            }
        }, 100);
    });
    
    // 채팅 삭제 이벤트
    eventSource.on(event_types.CHAT_DELETED, function(chatName) {
        //console.log('ThemePresetManager: 채팅 삭제 감지 (내장 이벤트)', chatName);
        setTimeout(() => {
            updateCurrentStatus();
        }, 100);
    });
    
    // 캐릭터 선택 이벤트 (내장 이벤트 사용)
    eventSource.on('character_selected', function() {
        //console.log('ThemePresetManager: 캐릭터 변경 감지 (내장 이벤트)');
        setTimeout(() => {
            updateCurrentStatus();
            if (extension_settings[extensionName].autoApply) {
                autoApplyThemeWithSave();
            }
            
            // 상세설정 패널이 열려있으면 실시간 업데이트
            if ($("#ThemePresetManager_advancedPanel").is(":visible")) {
                //console.log('ThemePresetManager: 상세설정 패널이 열려있어 실시간 업데이트 실행');
                createAdvancedSettingsUI();
            }
        }, 100);
    });
    
    // 앱 준비 완료 이벤트
    eventSource.on(event_types.APP_READY, function() {
        //console.log('ThemePresetManager: 앱 준비 완료 감지');
        setTimeout(() => {
            updateCurrentStatus();
            if (extension_settings[extensionName].autoApply) {
                autoApplyThemeWithSave();
            }
        }, 100);
    });
    
    // 설정 로드 완료 이벤트
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, function() {
        //console.log('ThemePresetManager: 설정 로드 완료 감지');
        setTimeout(() => {
            updateCurrentStatus();
            if (extension_settings[extensionName].autoApply) {
                autoApplyThemeWithSave();
            }
            
            // 상세설정 패널이 열려있으면 실시간 업데이트
            if ($("#ThemePresetManager_advancedPanel").is(":visible")) {
                //console.log('ThemePresetManager: 상세설정 패널이 열려있어 실시간 업데이트 실행');
                createAdvancedSettingsUI();
            }
        }, 100);
    });
    
    // 배경 변경 감지 이벤트 (상세설정 패널이 열려있을 때만)
    eventSource.on(event_types.FORCE_SET_BACKGROUND, function(backgroundInfo) {
        //console.log('ThemePresetManager: 배경 변경 감지', backgroundInfo);
        
        // 상세설정 패널이 열려있을 때만 업데이트
        if ($("#ThemePresetManager_advancedPanel").is(":visible")) {
            //console.log('ThemePresetManager: 상세설정 패널이 열려있어 배경 변경 후 업데이트 실행');
            setTimeout(() => {
                createAdvancedSettingsUI();
            }, 200); // 배경 변경 완료 후 약간의 지연을 두고 업데이트
        }
    });
    
    // 페이지 로드 시 자동 적용 (활성화된 경우에만) - 백업용
    setTimeout(() => {
        updateCurrentStatus();
        if (extension_settings[extensionName].autoApply) {
            autoApplyThemeWithSave();
        }
    }, 2000); // 2초로 증가하여 UI 로딩 완료 대기
    
    console.log('ThemePresetManager: 확장 로드 완료', { currentChatId, currentCharacterId });
});

// 캐릭터 설정 내보내기 함수
function exportCharacterSettings() {
    //console.log('ThemePresetManager: 캐릭터 설정 내보내기 시작');
    
    const settings = extension_settings[extensionName];
    const currentCharacterId = getCurrentCharacterId();
    const currentCharacterName = getCurrentCharacterName();
    
    if (!currentCharacterId) {
        toastr.error('선택된 캐릭터가 없습니다.');
        return;
    }
    
    // 현재 캐릭터의 테마 데이터 가져오기
    const characterTheme = loadDataFromCharacter('themeData');
    if (!characterTheme) {
        toastr.error('현재 캐릭터에 저장된 테마가 없습니다.');
        return;
    }
    
    const exportData = {
        version: '1.0.0',
        timestamp: Date.now(),
        extensionName: extensionName,
        type: 'character',
        characterId: currentCharacterId,
        characterName: currentCharacterName,
        themeData: characterTheme
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ThemePresetManager_Character_${currentCharacterName}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    console.log('ThemePresetManager: 캐릭터 설정 내보내기 완료', exportData);
    toastr.success(`${currentCharacterName} 캐릭터의 테마 설정이 내보내기되었습니다.`);
}

// 채팅 설정 내보내기 함수
function exportChatSettings() {
    //console.log('ThemePresetManager: 채팅 설정 내보내기 시작');
    
    const currentChatId = getCurrentChatId();
    const currentChatName = getCurrentChatName();
    
    if (!currentChatId) {
        toastr.error('선택된 채팅이 없습니다.');
        return;
    }
    
    // 현재 채팅의 테마 데이터 가져오기
    const chatTheme = loadDataFromChat('themeData');
    if (!chatTheme) {
        toastr.error('현재 채팅에 저장된 테마가 없습니다.');
        return;
    }
    
    const exportData = {
        version: '1.0.0',
        timestamp: Date.now(),
        extensionName: extensionName,
        type: 'chat',
        chatId: currentChatId,
        chatName: currentChatName,
        themeData: chatTheme
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ThemePresetManager_Chat_${currentChatName}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    console.log('ThemePresetManager: 채팅 설정 내보내기 완료', exportData);
    toastr.success(`${currentChatName} 채팅의 테마 설정이 내보내기되었습니다.`);
}

// 캐릭터/채팅 설정 가져오기 함수
function importSpecificSettings(file) {
    //console.log('ThemePresetManager: 특정 설정 가져오기 시작');
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importData = JSON.parse(e.target.result);
            
            // 파일 형식 검증
            if (!importData.extensionName || importData.extensionName !== extensionName) {
                throw new Error('이 파일은 ThemePresetManager 확장의 설정 파일이 아닙니다.');
            }
            
            if (!importData.type || !importData.themeData) {
                throw new Error('올바른 형식의 설정 파일이 아닙니다.');
            }
            
            const isMergeMode = confirm(
                `설정 가져오기 방식을 선택하세요:\n\n` +
                `파일: ${importData.type === 'character' ? '캐릭터' : '채팅'} 설정\n` +
                `이름: ${importData.characterName || importData.chatName}\n\n` +
                `확인: 병합 모드 (기존 설정과 합치기)\n` +
                `취소: 대체 모드 (기존 설정을 완전히 덮어쓰기)`
            );
            
            //console.log('ThemePresetManager: 특정 설정 가져오기 방식 선택됨', { 
                type: importData.type, 
                isMergeMode 
            });
            
            if (importData.type === 'character') {
                // 캐릭터 설정 가져오기
                const currentCharacterId = getCurrentCharacterId();
                if (!currentCharacterId) {
                    throw new Error('선택된 캐릭터가 없습니다.');
                }
                
                const currentThemeData = loadDataFromCharacter('themeData');
                const newThemeData = isMergeMode && currentThemeData 
                    ? { ...currentThemeData, ...importData.themeData }
                    : importData.themeData;
                
                saveDataToCharacter('themeData', newThemeData);
                console.log('ThemePresetManager: 캐릭터 설정 가져오기 완료', { 
                    mode: isMergeMode ? '병합' : '대체',
                    themeData: newThemeData 
                });
                toastr.success(`캐릭터 테마 설정이 가져와졌습니다. (${isMergeMode ? '병합' : '대체'} 모드)`);
                
            } else if (importData.type === 'chat') {
                // 채팅 설정 가져오기
                const currentChatId = getCurrentChatId();
                if (!currentChatId) {
                    throw new Error('선택된 채팅이 없습니다.');
                }
                
                const currentThemeData = loadDataFromChat('themeData');
                const newThemeData = isMergeMode && currentThemeData 
                    ? { ...currentThemeData, ...importData.themeData }
                    : importData.themeData;
                
                saveDataToChat('themeData', newThemeData);
                console.log('ThemePresetManager: 채팅 설정 가져오기 완료', { 
                    mode: isMergeMode ? '병합' : '대체',
                    themeData: newThemeData 
                });
                toastr.success(`채팅 테마 설정이 가져와졌습니다. (${isMergeMode ? '병합' : '대체'} 모드)`);
            }
            
            // UI 업데이트
            updateCurrentStatus();
            
        } catch (error) {
            console.error('ThemePresetManager: 특정 설정 가져오기 오류', error);
            toastr.error(`설정 가져오기에 실패했습니다: ${error.message}`);
        }
    };
    reader.readAsText(file);
}

// 새로운 특정 설정 내보내기/가져오기 이벤트 핸들러
function onExportCharacterSettings() {
    exportCharacterSettings();
}

function onExportChatSettings() {
    exportChatSettings();
}

function onImportSpecificSettings() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = function(e) {
        const file = e.target.files[0];
        if (file) {
            importSpecificSettings(file);
        }
    };
    input.click();
}