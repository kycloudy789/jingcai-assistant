Component({
  properties: {
    title: { type: String, value: '暂无数据' },
    desc: { type: String, value: '' },
    actionText: { type: String, value: '' },
  },
  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});
