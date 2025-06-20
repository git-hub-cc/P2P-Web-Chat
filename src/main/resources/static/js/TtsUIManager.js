/**
 * @file TtsUIManager.js
 * @description 文本转语音 (TTS) UI 管理器，负责填充和处理 AI 联系人详情面板中的 TTS 配置表单。
 *              它将 TTS 相关的 UI 逻辑从 DetailsPanelUIManager 中分离出来。
 *              新增支持动态获取 TTS 模型、说话人和情感的模式。
 *              修复了TTS模型/说话人端点不响应用户配置变更的问题。
 *              新增“版本”下拉框，用于在动态模式下指定获取模型时使用的 API 版本。
 *              TTS模型名称动态获取时，使用可搜索下拉框。
 * @module TtsUIManager
 * @exports {object} TtsUIManager - 对外暴露的单例对象，包含管理 TTS 配置 UI 的方法。
 * @property {function} populateAiTtsConfigurationForm - 根据联系人配置动态生成 TTS 设置表单。
 * @property {function} handleSaveAiTtsSettings - 处理保存 TTS 设置的逻辑。
 * @dependencies Utils, UserManager, NotificationUIManager, Config, AiApiHandler
 * @dependents DetailsPanelUIManager (在更新详情面板时调用)
 */
const TtsUIManager = {
    // 定义 TTS 配置表单的所有字段及其属性
    TTS_CONFIG_FIELDS: [
        {
            key: 'tts_mode', label: 'TTS 模式', type: 'select', default: 'Dynamic',
            options: [{value: 'Preset', text: '预设值'},{value: 'Dynamic', text: '动态获取'}],
            isAdvanced: false
        },
        {
            key: 'version', label: '版本', type: 'select', default: 'v4',
            options: [
                {value: 'v2', text: 'v2'}, {value: 'v3', text: 'v3'},
                {value: 'v4', text: 'v4'}, {value: 'v2Pro', text: 'v2Pro'},
                {value: 'v2ProPlus', text: 'v2ProPlus'}
            ],
            isAdvanced: false
        },
        { key: 'enabled', label: '启用 TTS', type: 'checkbox', default: false, isAdvanced: false },
        { key: 'model_name', label: '模型名称', type: 'text', default: 'GPT-SoVITS', isPotentiallyDynamic: true, isAdvanced: false }, // 在动态模式下会变成可搜索select
        { key: 'prompt_text_lang', label: '参考音频语言', type: 'select', default: '中文', options: ["中文", "英语", "日语"], isPotentiallyDynamic: true, isAdvanced: false }, // 在动态模式下会变成select
        { key: 'emotion', label: '情感', type: 'text', default: '开心_happy', isPotentiallyDynamic: true, isAdvanced: false }, // 在动态模式下会变成select
        { key: 'text_lang', label: '文本语言', type: 'select', default: '中文', options: ["中文", "英语", "日语", "粤语", "韩语", "中英混合", "日英混合", "粤英混合", "韩英混合", "多语种混合", "多语种混合（粤语）"], isAdvanced: false },
        { key: 'text_split_method', label: '切分方法', type: 'select', default: '按标点符号切', options: ["四句一切", "凑50字一切", "按中文句号。切", "按英文句号.切", "按标点符号切"], isAdvanced: false },
        { key: 'seed', label: '种子', type: 'number', default: -1, step:1, isAdvanced: false },
        { key: 'media_type', label: '媒体类型', type: 'select', default: 'wav', options: ["wav", "mp3", "ogg"], isAdvanced: true },
        { key: 'fragment_interval', label: '分段间隔', type: 'number', default: 0.3, step:0.01, min:0, isAdvanced: true },
        { key: 'speed_facter', label: '语速', type: 'number', default: 1.0, step:0.1, min:0.1, max:3.0, isAdvanced: true },
        { key: 'parallel_infer', label: '并行推理', type: 'checkbox', default: true, isAdvanced: true },
        { key: 'batch_threshold', label: '批处理阈值', type: 'number', default: 0.75, step:0.01, min:0, max:1, isAdvanced: true },
        { key: 'split_bucket', label: '分桶', type: 'checkbox', default: true, isAdvanced: true },
        { key: 'batch_size', label: '批处理大小', type: 'number', default: 10, step:1, min:1, max:100, isAdvanced: true },
        { key: 'top_k', label: 'Top K', type: 'number', default: 10, step:1, min:1, max:100, isAdvanced: true },
        { key: 'top_p', label: 'Top P', type: 'number', default: 0.01, step:0.01, min:0, max:1, isAdvanced: true },
        { key: 'temperature', label: '温度', type: 'number', default: 1.0, step:0.01, min:0.01, max:1, isAdvanced: true },
        { key: 'repetition_penalty', label: '重复惩罚', type: 'number', default: 1.35, step:0.01, min:0, max:2, isAdvanced: true },
    ],
    _boundSaveTtsListener: null,
    _dynamicDataCache: {},

    /**
     * 根据联系人的配置动态生成并填充 AI TTS 配置表单。
     * @param {object} contact - AI 联系人对象。
     * @param {string} [formContainerId='ttsConfigFormContainer'] - 表单容器的 DOM ID。
     */
    populateAiTtsConfigurationForm: function(contact, formContainerId = 'ttsConfigFormContainer') {
        const formContainer = document.getElementById(formContainerId);
        if (!formContainer) {
            Utils.log(`未找到 TTS 表单容器 '${formContainerId}'。`, Utils.logLevels.ERROR);
            return;
        }

        formContainer.innerHTML = '';
        const ttsSettings = (contact.aiConfig && contact.aiConfig.tts) ? JSON.parse(JSON.stringify(contact.aiConfig.tts)) : {};
        const currentTtsMode = ttsSettings.tts_mode || 'Preset';
        const currentVersion = ttsSettings.version || 'v4';

        const basicFieldsContainer = document.createElement('div');
        const advancedFieldsContainer = document.createElement('div');
        advancedFieldsContainer.className = 'collapsible-content tts-advanced-fields-container';
        advancedFieldsContainer.style.display = 'none';

        this.TTS_CONFIG_FIELDS.forEach(field => {
            const parentEl = field.isAdvanced ? advancedFieldsContainer : basicFieldsContainer;
            this._createFieldElement(field, parentEl, ttsSettings, currentTtsMode, currentVersion, contact.id, formContainer);
        });

        formContainer.appendChild(basicFieldsContainer);

        if (advancedFieldsContainer.childElementCount > 0) {
            const advancedSectionDiv = document.createElement('div');
            advancedSectionDiv.className = 'tts-config-section advanced-tts-section';
            const advancedHeader = document.createElement('div');
            advancedHeader.className = 'collapsible-header tts-advanced-header';
            advancedHeader.innerHTML = `<h5>高级选项</h5><span class="collapse-icon">▶</span>`;
            advancedHeader.style.cursor = 'pointer';
            advancedHeader.addEventListener('click', function() {
                this.classList.toggle('active');
                const icon = this.querySelector('.collapse-icon');
                if (advancedFieldsContainer.style.display === "block" || advancedFieldsContainer.style.display === "") {
                    advancedFieldsContainer.style.display = "none";
                    if(icon) icon.textContent = '▶';
                } else {
                    advancedFieldsContainer.style.display = "block";
                    if(icon) icon.textContent = '▼';
                }
            });
            advancedSectionDiv.appendChild(advancedHeader);
            advancedSectionDiv.appendChild(advancedFieldsContainer);
            formContainer.appendChild(advancedSectionDiv);
        }
        if (currentTtsMode === 'Dynamic' && currentVersion) {
            this._handleVersionChange(currentVersion, contact.id, formContainer, ttsSettings.model_name, ttsSettings.prompt_text_lang, ttsSettings.emotion);
        }
    },

    /**
     * @private
     * 创建单个表单字段的 DOM 元素。
     * @param {object} fieldDef - 字段定义对象。
     * @param {HTMLElement} parentEl - 该字段应附加到的父元素。
     * @param {object} currentTtsSettings - 当前联系人的 TTS 设置。
     * @param {string} currentTtsMode - 当前选中的 TTS 模式 ('Preset' 或 'Dynamic')。
     * @param {string} currentVersion - 当前选中的版本。
     * @param {string} contactId - 当前联系人的 ID。
     * @param {HTMLElement} formContainer - 整个表单的容器，用于重新渲染。
     */
    _createFieldElement: function(fieldDef, parentEl, currentTtsSettings, currentTtsMode, currentVersion, contactId, formContainer) {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'tts-config-item';
        const label = document.createElement('label');
        label.htmlFor = `ttsInput_${contactId}_${fieldDef.key}`;
        label.textContent = fieldDef.label + ':';
        itemDiv.appendChild(label);

        let input;
        const savedValue = currentTtsSettings[fieldDef.key] !== undefined ? currentTtsSettings[fieldDef.key] : fieldDef.default;

        if (fieldDef.key === 'tts_mode') {
            input = document.createElement('select');
            this._populateSelectWithOptions(input, fieldDef.options, currentTtsMode, '');
            input.addEventListener('change', (e) => {
                const contactToUpdate = UserManager.contacts[contactId];
                if (contactToUpdate && contactToUpdate.aiConfig && contactToUpdate.aiConfig.tts) {
                    contactToUpdate.aiConfig.tts.tts_mode = e.target.value;
                }
                this.populateAiTtsConfigurationForm(UserManager.contacts[contactId], formContainer.id);
            });
        } else if (fieldDef.key === 'version') {
            input = document.createElement('select');
            this._populateSelectWithOptions(input, fieldDef.options, currentVersion, '');
            input.addEventListener('change', (e) => {
                const newVersion = e.target.value;
                const contactToUpdate = UserManager.contacts[contactId];
                if (contactToUpdate && contactToUpdate.aiConfig && contactToUpdate.aiConfig.tts) {
                    contactToUpdate.aiConfig.tts.version = newVersion;
                    contactToUpdate.aiConfig.tts.model_name = undefined;
                    contactToUpdate.aiConfig.tts.prompt_text_lang = undefined;
                    contactToUpdate.aiConfig.tts.emotion = undefined;
                }
                if (currentTtsMode === 'Dynamic') {
                    this._handleVersionChange(newVersion, contactId, formContainer, undefined, undefined, undefined);
                }
            });
        } else if (fieldDef.key === 'model_name' && currentTtsMode === 'Dynamic') {
            // Create searchable select for model_name in Dynamic mode
            input = this._createSearchableSelect(
                `ttsInput_${contactId}_${fieldDef.key}`,
                [], // Options will be populated by _handleVersionChange
                savedValue,
                `加载${fieldDef.label}...`,
                (selectedValue) => { // onSelectionChange callback
                    this._handleModelChange(selectedValue, currentVersion, contactId, formContainer, currentTtsSettings.prompt_text_lang, currentTtsSettings.emotion);
                }
            );
        } else if (fieldDef.isPotentiallyDynamic && currentTtsMode === 'Dynamic') { // For prompt_text_lang and emotion
            input = document.createElement('select');
            input.disabled = true;
            this._populateSelectWithOptions(input, [], savedValue, `加载${fieldDef.label}...`);

            if (fieldDef.key === 'prompt_text_lang') {
                input.addEventListener('change', (e) => this._handleLanguageChange(e.target.value, currentTtsSettings.model_name, currentVersion, contactId, formContainer, currentTtsSettings.emotion));
            }
            // Emotion select is populated by _handleLanguageChange, no separate onchange needed here
        } else if (fieldDef.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = savedValue;
        } else if (fieldDef.type === 'select' && !fieldDef.isPotentiallyDynamic) {
            input = document.createElement('select');
            this._populateSelectWithOptions(input, fieldDef.options.map(opt => (typeof opt === 'string' ? {value: opt, text: opt} : opt)), savedValue, '');
        } else {
            input = document.createElement('input');
            input.type = fieldDef.type;
            input.value = savedValue;
            if (fieldDef.step !== undefined) input.step = fieldDef.step;
            if (fieldDef.min !== undefined) input.min = fieldDef.min;
            if (fieldDef.max !== undefined) input.max = fieldDef.max;
            if (fieldDef.type === 'text' && fieldDef.default !== undefined) input.placeholder = String(fieldDef.default);
        }

        // If it's not the searchable select, set common attributes
        if (!(fieldDef.key === 'model_name' && currentTtsMode === 'Dynamic')) {
            input.id = `ttsInput_${contactId}_${fieldDef.key}`;
            input.dataset.ttsParam = fieldDef.key;
        }
        // The searchable select itself is a div, so `input` here is the main container div for it.
        itemDiv.appendChild(input);
        parentEl.appendChild(itemDiv);
    },

    /**
     * @private
     * Creates a custom searchable select component.
     * @param {string} idBase - Base ID for the elements within the component.
     * @param {Array<object>} optionsArray - Initial array of {value, text} options.
     * @param {string|null} selectedValue - The initially selected value.
     * @param {string} placeholderText - Placeholder for the input field.
     * @param {function} onSelectionChange - Callback function when a selection is made, passes the selected value.
     * @returns {HTMLElement} The main container div of the searchable select.
     */
    _createSearchableSelect: function(idBase, optionsArray, selectedValue, placeholderText, onSelectionChange) {
        const container = document.createElement('div');
        container.className = 'searchable-select-tts'; // Use a specific class for TTS version
        container.id = idBase; // The main container gets the ID for form processing
        container.dataset.ttsParam = idBase.substring(idBase.lastIndexOf('_') + 1); // Store field key

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'searchable-select-input-tts';
        input.placeholder = placeholderText;
        input.autocomplete = 'off';

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'searchable-select-options-container-tts';
        optionsContainer.style.display = 'none';

        container.appendChild(input);
        container.appendChild(optionsContainer);

        let currentFullOptions = [...optionsArray]; // Store all available options for filtering

        const populateOptions = (filterText = '') => {
            optionsContainer.innerHTML = '';
            const filteredOptions = currentFullOptions.filter(opt =>
                opt.text.toLowerCase().includes(filterText.toLowerCase())
            );

            if (filteredOptions.length === 0 && filterText) {
                const noResultOpt = document.createElement('div');
                noResultOpt.className = 'searchable-select-option-tts no-results';
                noResultOpt.textContent = '无匹配项';
                optionsContainer.appendChild(noResultOpt);
            } else if (currentFullOptions.length === 0 && !filterText) {
                const loadingOpt = document.createElement('div');
                loadingOpt.className = 'searchable-select-option-tts no-results'; // reuse style
                loadingOpt.textContent = placeholderText || '加载中...';
                optionsContainer.appendChild(loadingOpt);
            }

            filteredOptions.forEach(opt => {
                const optionDiv = document.createElement('div');
                optionDiv.className = 'searchable-select-option-tts';
                optionDiv.textContent = opt.text;
                optionDiv.dataset.value = opt.value;
                optionDiv.addEventListener('click', () => {
                    input.value = opt.text;
                    container.dataset.selectedValue = opt.value; // Store actual value on main container
                    optionsContainer.style.display = 'none';
                    if (typeof onSelectionChange === 'function') {
                        onSelectionChange(opt.value);
                    }
                });
                optionsContainer.appendChild(optionDiv);
            });
            optionsContainer.style.display = (filteredOptions.length > 0 || (filterText && filteredOptions.length === 0) || (currentFullOptions.length === 0 && !filterText) ) ? 'block' : 'none';
        };

        // Method to update the options list externally (e.g., after API call)
        container.updateOptions = (newOptions, newSelectedValue) => {
            currentFullOptions = [...newOptions];
            const selectedOpt = currentFullOptions.find(opt => opt.value === newSelectedValue);
            if (selectedOpt) {
                input.value = selectedOpt.text;
                container.dataset.selectedValue = selectedOpt.value;
            } else if (newOptions.length > 0 && !newSelectedValue) {
                // If no specific value is selected, but options exist, clear display or show placeholder
                // input.value = ''; // Or placeholder
                // delete container.dataset.selectedValue;
                // For now, if newSelectedValue is not provided, we keep the input as is, assuming it might be a search term or placeholder
                if (!input.value && placeholderText) input.placeholder = placeholderText;
            } else if (newOptions.length === 0) {
                input.value = '';
                input.placeholder = placeholderText || '无可用选项';
                delete container.dataset.selectedValue;
            }
            populateOptions(input.value === (selectedOpt ? selectedOpt.text : '') ? '' : input.value); // Re-filter or show all
        };

        // Initial population with selectedValue if provided
        const initialSelectedOption = optionsArray.find(opt => opt.value === selectedValue);
        if (initialSelectedOption) {
            input.value = initialSelectedOption.text;
            container.dataset.selectedValue = initialSelectedOption.value;
        } else if (selectedValue && placeholderText.startsWith('加载')) { // If value exists but options are loading
            input.value = selectedValue; // Show the saved value while loading
            container.dataset.selectedValue = selectedValue;
        }


        input.addEventListener('input', () => {
            populateOptions(input.value);
            // Clear data-selected-value if user types something different from a known option's text
            const currentOptionByText = currentFullOptions.find(opt => opt.text === input.value);
            if (!currentOptionByText) {
                delete container.dataset.selectedValue;
            } else {
                container.dataset.selectedValue = currentOptionByText.value;
            }
        });

        input.addEventListener('focus', () => {
            populateOptions(input.value); // Show options matching current input, or all if input is empty/just placeholder
        });

        input.addEventListener('click', (event) => { // Prevent body click listener from closing immediately
            event.stopPropagation();
            populateOptions(input.value);
        });

        // Hide options if clicked outside
        // This listener is added once per TtsUIManager instance, not per select
        if (!TtsUIManager._searchableSelectGlobalListenerAttached) {
            document.addEventListener('click', (e) => {
                document.querySelectorAll('.searchable-select-tts').forEach(sSelect => {
                    if (!sSelect.contains(e.target)) {
                        const optsContainer = sSelect.querySelector('.searchable-select-options-container-tts');
                        if (optsContainer) optsContainer.style.display = 'none';
                    }
                });
            });
            TtsUIManager._searchableSelectGlobalListenerAttached = true;
        }

        container.updateOptions(optionsArray, selectedValue); // Initial population
        return container;
    },
    _searchableSelectGlobalListenerAttached: false,


    /**
     * @private
     * 填充下拉选择框的选项。
     * @param {HTMLSelectElement} selectElement - 要填充的 select 元素。
     * @param {Array<object>} optionsArray - 选项数组, e.g. [{value: 'val1', text: 'Text 1'}].
     * @param {string|null} selectedValue - 应预选的值。
     * @param {string} placeholderText - 当 optionsArray 为空或需要占位符时显示的文本。
     */
    _populateSelectWithOptions: function(selectElement, optionsArray, selectedValue, placeholderText) {
        selectElement.innerHTML = '';
        if (!optionsArray || optionsArray.length === 0) {
            if (placeholderText) {
                const placeholderOption = document.createElement('option');
                placeholderOption.value = "";
                placeholderOption.textContent = placeholderText;
                placeholderOption.disabled = true;
                placeholderOption.selected = !selectedValue;
                selectElement.appendChild(placeholderOption);
            }
            return;
        }

        optionsArray.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.text;
            if (selectedValue && option.value === selectedValue) {
                option.selected = true;
            }
            selectElement.appendChild(option);
        });
    },

    /**
     * @private
     * 处理动态模式下版本选择框的更改事件。
     * @param {string} selectedVersion - 新选中的版本。
     * @param {string} contactId - 当前联系人的 ID。
     * @param {HTMLElement} formContainer - 整个表单的容器。
     * @param {string|undefined} [initialModel] - 尝试预选的模型。
     * @param {string|undefined} [initialLang] - 尝试预选的语言。
     * @param {string|undefined} [initialEmotion] - 尝试预选的情感。
     */
    _handleVersionChange: async function(selectedVersion, contactId, formContainer, initialModel, initialLang, initialEmotion) {
        const modelSearchableSelectContainer = formContainer.querySelector(`#ttsInput_${contactId}_model_name`); // This is the main div container
        const langSelect = formContainer.querySelector(`#ttsInput_${contactId}_prompt_text_lang`);
        const emotionSelect = formContainer.querySelector(`#ttsInput_${contactId}_emotion`);

        if (modelSearchableSelectContainer && typeof modelSearchableSelectContainer.updateOptions === 'function') {
            modelSearchableSelectContainer.updateOptions([], null); // Clear existing, show loading
            modelSearchableSelectContainer.querySelector('.searchable-select-input-tts').placeholder = '加载模型...';
            modelSearchableSelectContainer.querySelector('.searchable-select-input-tts').disabled = true;
        }
        [langSelect, emotionSelect].forEach(sel => {
            if (sel) {
                sel.innerHTML = ''; sel.disabled = true;
                let placeholder = '加载中...';
                if (sel === langSelect) placeholder = '选择模型后加载...';
                else if (sel === emotionSelect) placeholder = '选择语言后加载...';
                this._populateSelectWithOptions(sel, [], null, placeholder);
            }
        });

        if (selectedVersion && modelSearchableSelectContainer) {
            try {
                const models = await this._fetchTtsModels(selectedVersion);
                if (typeof modelSearchableSelectContainer.updateOptions === 'function') {
                    modelSearchableSelectContainer.updateOptions(models.map(m => ({value: m, text: m})), initialModel);
                    modelSearchableSelectContainer.querySelector('.searchable-select-input-tts').disabled = false;
                    modelSearchableSelectContainer.querySelector('.searchable-select-input-tts').placeholder = '搜索/选择模型...';

                    const currentSelectedModel = modelSearchableSelectContainer.dataset.selectedValue || (initialModel && models.includes(initialModel) ? initialModel : null);
                    if (currentSelectedModel) {
                        this._handleModelChange(currentSelectedModel, selectedVersion, contactId, formContainer, initialLang, initialEmotion);
                    } else if (models.length > 0) {
                        // If no model is pre-selected but models are available, clear dependent dropdowns
                        if(langSelect) this._populateSelectWithOptions(langSelect, [], null, '选择模型后加载...');
                        if(emotionSelect) this._populateSelectWithOptions(emotionSelect, [], null, '选择语言后加载...');
                    }
                }
            } catch (err) {
                Utils.log(`加载TTS模型失败 (版本: ${selectedVersion}): ${err.message}`, Utils.logLevels.ERROR);
                if (modelSearchableSelectContainer && typeof modelSearchableSelectContainer.updateOptions === 'function') {
                    modelSearchableSelectContainer.updateOptions([], null);
                    modelSearchableSelectContainer.querySelector('.searchable-select-input-tts').placeholder = '加载模型失败';
                }
            }
        }
    },

    _handleModelChange: async function(selectedModel, version, contactId, formContainer, initialLang, initialEmotion) {
        const langSelect = formContainer.querySelector(`#ttsInput_${contactId}_prompt_text_lang`);
        const emotionSelect = formContainer.querySelector(`#ttsInput_${contactId}_emotion`);

        if (langSelect) { langSelect.innerHTML = ''; langSelect.disabled = true; this._populateSelectWithOptions(langSelect, [], null, '加载语言...'); }
        if (emotionSelect) { emotionSelect.innerHTML = ''; emotionSelect.disabled = true; this._populateSelectWithOptions(emotionSelect, [], null, '选择语言后加载...'); }

        if (selectedModel && this._dynamicDataCache[version] && this._dynamicDataCache[version][selectedModel]) {
            const modelData = this._dynamicDataCache[version][selectedModel];
            const languages = Object.keys(modelData);

            if (langSelect) {
                this._populateSelectWithOptions(langSelect, languages.map(lang => ({value: lang, text: lang})), initialLang, '选择语言');
                langSelect.disabled = false;

                const currentSelectedLang = langSelect.value || (initialLang && languages.includes(initialLang) ? initialLang : null);
                if (currentSelectedLang) {
                    this._handleLanguageChange(currentSelectedLang, selectedModel, version, contactId, formContainer, initialEmotion);
                } else if (languages.length > 0) {
                    if(emotionSelect) this._populateSelectWithOptions(emotionSelect, [], null, '选择语言后加载...');
                }
            }
        } else if (selectedModel) {
            Utils.log(`在 _handleModelChange 中未找到模型 ${selectedModel} (版本 ${version}) 的缓存数据。`, Utils.logLevels.WARN);
        }
    },

    _handleLanguageChange: function(selectedLanguage, selectedModel, version, contactId, formContainer, initialEmotion) {
        const emotionSelect = formContainer.querySelector(`#ttsInput_${contactId}_emotion`);
        if (emotionSelect) { emotionSelect.innerHTML = ''; emotionSelect.disabled = true; this._populateSelectWithOptions(emotionSelect, [], null, '加载情感...'); }

        if (selectedModel && selectedLanguage &&
            this._dynamicDataCache[version] &&
            this._dynamicDataCache[version][selectedModel] &&
            this._dynamicDataCache[version][selectedModel][selectedLanguage]) {
            const emotions = this._dynamicDataCache[version][selectedModel][selectedLanguage];

            if (emotionSelect) {
                this._populateSelectWithOptions(emotionSelect, emotions.map(em => ({value: em, text: em})), initialEmotion, '选择情感');
                emotionSelect.disabled = false;
            }
        } else if (selectedModel && selectedLanguage && emotionSelect) {
            Utils.log(`在 _handleLanguageChange 中未找到模型 ${selectedModel} / 语言 ${selectedLanguage} (版本 ${version}) 的缓存数据。`, Utils.logLevels.WARN);
        }
    },

    _fetchTtsModels: async function(version) {
        const effectiveConfig = AiApiHandler._getEffectiveAiConfig();
        if (!effectiveConfig.ttsApiEndpoint) {
            throw new Error('TTS API 端点未配置。');
        }
        const modelsUrl = effectiveConfig.ttsApiEndpoint.endsWith('/') ?
            effectiveConfig.ttsApiEndpoint + 'models' :
            effectiveConfig.ttsApiEndpoint + '/models';
        Utils.log(`正在从 ${modelsUrl} (版本: ${version}) 获取 TTS 模型...`, Utils.logLevels.DEBUG);

        const response = await fetch(modelsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer guest' },
            body: JSON.stringify({ version: version })
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "无法读取错误响应");
            throw new Error(`获取 TTS 模型失败 (版本: ${version}): ${response.status} ${errorText.substring(0,100)}`);
        }
        const data = await response.json();
        if (!data || typeof data.models !== 'object') {
            throw new Error(`TTS 模型 API (版本: ${version}) 响应格式无效，期望 'models' 字段为对象。`);
        }

        if (!this._dynamicDataCache) this._dynamicDataCache = {};
        this._dynamicDataCache[version] = data.models;
        Utils.log(`成功获取并缓存了版本 ${version} 的 ${Object.keys(data.models).length} 个 TTS 模型。`, Utils.logLevels.DEBUG);
        return Object.keys(data.models);
    },

    _fetchTtsSpeakers: async function(version, modelName) {
        if (this._dynamicDataCache[version] && this._dynamicDataCache[version][modelName]) {
            Utils.log(`直接从缓存返回模型 ${modelName} (版本 ${version}) 的数据。`, Utils.logLevels.DEBUG);
            return this._dynamicDataCache[version][modelName];
        }
        Utils.log(`警告: _fetchTtsSpeakers 被调用，但模型 ${modelName} (版本 ${version}) 的数据应已在 _fetchTtsModels 中缓存。`, Utils.logLevels.WARN);
        return {};
    },

    handleSaveAiTtsSettings: async function(contactId) {
        const contact = UserManager.contacts[contactId];
        if (!contact || !contact.isAI || !contact.aiConfig) {
            NotificationUIManager.showNotification("错误: 未找到联系人或非 AI 联系人。", "error");
            return;
        }

        if (!contact.aiConfig.tts) contact.aiConfig.tts = {};
        let changesMade = false;
        const newTtsSettings = { ...contact.aiConfig.tts };

        this.TTS_CONFIG_FIELDS.forEach(field => {
            const inputElementOrContainer = document.getElementById(`ttsInput_${contactId}_${field.key}`);
            if (inputElementOrContainer) {
                let newValue;
                // Check if it's our custom searchable select
                if (inputElementOrContainer.classList.contains('searchable-select-tts')) {
                    newValue = inputElementOrContainer.dataset.selectedValue ||
                        (inputElementOrContainer.querySelector('.searchable-select-input-tts') ?
                            inputElementOrContainer.querySelector('.searchable-select-input-tts').value : // fallback to displayed text if no data-value
                            field.default); // fallback to default if nothing else
                    // If it was a placeholder like "加载模型...", and no selection made, treat as undefined or default
                    if(newValue === `加载${field.label}...` || newValue === '选择模型' || newValue === '选择语言' || newValue === '选择情感') {
                        newValue = currentTtsSettings[field.key] !== undefined ? currentTtsSettings[field.key] : field.default; // Keep old or default
                    }

                } else if (inputElementOrContainer.type === 'checkbox') {
                    newValue = inputElementOrContainer.checked;
                } else if (inputElementOrContainer.type === 'number') {
                    newValue = parseFloat(inputElementOrContainer.value);
                    if (isNaN(newValue)) newValue = field.default;
                } else {
                    newValue = inputElementOrContainer.value;
                }

                if (newTtsSettings[field.key] !== newValue) {
                    changesMade = true;
                }
                newTtsSettings[field.key] = newValue;
            }
        });

        if (changesMade) {
            contact.aiConfig.tts = newTtsSettings;
            try {
                localStorage.setItem(`ttsConfig_${contactId}`, JSON.stringify(newTtsSettings));
                await UserManager.saveContact(contactId);
                NotificationUIManager.showNotification("TTS 设置已成功保存。", "success");
            } catch (error) {
                Utils.log(`为 ${contactId} 保存 TTS 设置失败: ${error}`, Utils.logLevels.ERROR);
                NotificationUIManager.showNotification("保存 TTS 设置失败。", "error");
            }
        } else {
            NotificationUIManager.showNotification("未对 TTS 设置进行任何更改。", "info");
        }
    }
};