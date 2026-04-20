// qufox mobile mockups — renders into #mobile-mount
// Uses window.IOSDevice from ios-frame.jsx
const { useState } = React;

function QFoxSymbol({ size=28 }) {
  return <img src="../brand-assets/svg/fox-symbol-dark.svg" width={size} height={size} alt="" style={{borderRadius:8}}/>;
}

function MobileScreen({children, topbar, tabbar, composer, fab, bodyStyle={}}) {
  return (
    <div className="qf-m-screen" style={{background:'var(--bg-chat)'}}>
      {topbar}
      <div className="qf-m-body" style={bodyStyle}>{children}</div>
      {composer}
      {fab}
      {tabbar}
    </div>
  );
}

function TabBar({active='home'}) {
  const tabs = [
    {k:'home',   i:'🏠', l:'Home'},
    {k:'dms',    i:'💬', l:'DMs', badge:'3'},
    {k:'notifs', i:'🔔', l:'Activity', dot:true},
    {k:'you',    i:'👤', l:'You'},
  ];
  return (
    <nav className="qf-m-tabbar">
      {tabs.map(t => (
        <button key={t.k} className="qf-m-tab" aria-selected={active===t.k}>
          <span className="qf-m-tab__icon">{t.i}</span>
          <span className="qf-m-tab__label">{t.l}</span>
          {t.badge && <span className="qf-m-tab__badge">{t.badge}</span>}
          {t.dot && <span className="qf-m-tab__dot"/>}
        </button>
      ))}
    </nav>
  );
}

// ───── Screen 1: DMs list (Slack-like) ─────
function ScreenDMs() {
  const items = [
    {n:'founder_park', r:'👑', s:'금요일에 스프린트 리뷰 잡을까요?', t:'14:23', u:true, c:'var(--warn-400)'},
    {n:'dev_lee',      r:'MOD', s:'브랜드 에셋 머지했습니다 🦊',      t:'13:47', u:true, c:'var(--a-500)', unread:3},
    {n:'designer_kim', r:'',   s:'타이포 토큰 정리 완료',            t:'어제',  u:false, c:'var(--a-600)'},
    {n:'pm_choi',      r:'',   s:'내일 오전 10시 괜찮으세요?',        t:'어제',  u:false, c:'var(--a-300)'},
    {n:'eng_jung',     r:'',   s:'You: 네 확인했습니다',              t:'월요일',u:false, c:'var(--a-700)'},
    {n:'ops_han',      r:'',   s:'배포 롤백했습니다. 로그 확인 바랍니다.', t:'월요일', u:false, c:'var(--a-400)'},
  ];
  return (
    <MobileScreen
      topbar={
        <div className="qf-m-topbar">
          <button className="qf-m-topbar__back" style={{background:'var(--a-500)',color:'#fff',borderRadius:8,fontSize:14,fontWeight:700}}>Q</button>
          <div className="qf-m-topbar__titleBlock">
            <div className="qf-m-topbar__title">Direct messages</div>
            <div className="qf-m-topbar__subtitle">qufox team</div>
          </div>
          <div className="qf-m-topbar__actions">
            <button className="qf-m-topbar__action">🔍</button>
            <button className="qf-m-topbar__action">✏️</button>
          </div>
        </div>
      }
      tabbar={<TabBar active="dms"/>}
      fab={<button className="qf-m-fab">✏️</button>}
    >
      <div className="qf-m-search" style={{marginTop:12}}>
        <span>🔍</span>
        <input className="qf-m-search__input" placeholder="이름, 채널, 메시지 검색"/>
      </div>
      <div className="qf-m-section">Pinned <span className="qf-m-section__action">See all</span></div>
      {items.slice(0,2).map((it,i)=>(
        <div key={i} className={'qf-m-row'+(it.u?' qf-m-row--unread':'')}>
          <div className="qf-avatar qf-avatar--md" style={{background:it.c}}><span className={'qf-avatar__status qf-avatar__status--'+(i===0?'online':'online')}/></div>
          <div style={{minWidth:0}}>
            <div className="qf-m-row__primary">{it.n} {it.r && <span className="qf-badge qf-badge--accent" style={{marginLeft:4}}>{it.r}</span>}</div>
            <div className="qf-m-row__secondary">{it.s}</div>
          </div>
          <div className="qf-m-row__aside">
            <span className="qf-m-row__time">{it.t}</span>
            {it.unread && <span className="qf-badge qf-badge--count">{it.unread}</span>}
          </div>
        </div>
      ))}
      <div className="qf-m-section">All conversations</div>
      {items.slice(2).map((it,i)=>(
        <div key={i} className="qf-m-row">
          <div className="qf-avatar qf-avatar--md" style={{background:it.c}}><span className={'qf-avatar__status qf-avatar__status--'+(i%2?'idle':'offline')}/></div>
          <div style={{minWidth:0}}>
            <div className="qf-m-row__primary">{it.n}</div>
            <div className="qf-m-row__secondary">{it.s}</div>
          </div>
          <div className="qf-m-row__aside"><span className="qf-m-row__time">{it.t}</span></div>
        </div>
      ))}
    </MobileScreen>
  );
}

// ───── Screen 2: Channel view (Discord-like) ─────
function ScreenChannel() {
  return (
    <MobileScreen
      topbar={
        <div className="qf-m-topbar">
          <button className="qf-m-topbar__back">☰</button>
          <div className="qf-m-topbar__titleBlock">
            <div className="qf-m-topbar__title">
              <span style={{color:'var(--text-muted)'}}>#</span> general
            </div>
            <div className="qf-m-topbar__subtitle">qufox team · 42 members</div>
          </div>
          <div className="qf-m-topbar__actions">
            <button className="qf-m-topbar__action">📞</button>
            <button className="qf-m-topbar__action">👥</button>
          </div>
        </div>
      }
      composer={
        <div className="qf-m-composer">
          <button className="qf-m-composer__plus">+</button>
          <textarea className="qf-m-composer__input" placeholder="#general에 메시지" rows={1}/>
          <button className="qf-m-composer__send">➤</button>
        </div>
      }
      bodyStyle={{paddingTop:8,paddingBottom:4}}
    >
      <div style={{padding:'16px', textAlign:'center', color:'var(--text-muted)', fontSize:'var(--fs-13)'}}>
        — 오늘 오후 2:34 —
      </div>

      <div className="qf-m-msg qf-m-msg--head">
        <div className="qf-m-msg__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-500)'}}><span className="qf-avatar__status qf-avatar__status--online"/></div></div>
        <div>
          <div className="qf-m-msg__meta">
            <span className="qf-m-msg__author">dev_lee</span>
            <span className="qf-badge qf-badge--accent">MOD</span>
            <span className="qf-m-msg__time">14:34</span>
          </div>
          <div className="qf-m-msg__body">
            브랜드 에셋 전부 머지했습니다. <span className="qf-mention">@designer_kim</span> 확인 부탁드려요!
            <div className="qf-reactions">
              <div className="qf-reaction qf-reaction--me">🦊 <span>5</span></div>
              <div className="qf-reaction">🚀 <span>2</span></div>
            </div>
          </div>
        </div>
      </div>

      <div className="qf-m-msg qf-m-msg--head">
        <div className="qf-m-msg__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-700)'}}/></div>
        <div>
          <div className="qf-m-msg__meta">
            <span className="qf-m-msg__author">designer_kim</span>
            <span className="qf-m-msg__time">14:38</span>
          </div>
          <div className="qf-m-msg__body">
            좋아요! 토큰 값도 반영했어요:
            <pre className="qf-codeblock" style={{fontSize:12,marginTop:6}}><span className="qf-codeblock__lang">CSS</span>--r-xl: 14px;
--a-500: #8B5CF6;</pre>
          </div>
        </div>
      </div>

      <div className="qf-m-msg qf-m-msg--cont">
        <div className="qf-m-msg__avatar"><div className="qf-avatar qf-avatar--md"/></div>
        <div><div className="qf-m-msg__body">파비콘도 잘 보이네요 👀</div></div>
      </div>

      <div className="qf-m-msg qf-m-msg--head">
        <div className="qf-m-msg__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-400)'}}><span className="qf-avatar__status qf-avatar__status--idle"/></div></div>
        <div>
          <div className="qf-m-msg__meta">
            <span className="qf-m-msg__author">pm_choi</span>
            <span className="qf-m-msg__time">14:45</span>
          </div>
          <div className="qf-m-msg__body">
            <span className="qf-mention">@dev_lee</span> 혹시 스크린샷 공유 가능할까요?
          </div>
        </div>
      </div>

      <div className="qf-typing" style={{padding:'4px 16px'}}>
        <span className="qf-typing__dots"><span/><span/><span/></span>
        <span><strong style={{color:'var(--text-secondary)'}}>dev_lee</strong> 입력 중…</span>
      </div>
    </MobileScreen>
  );
}

// ───── Screen 3: Activity / Notifications ─────
function ScreenActivity() {
  return (
    <MobileScreen
      topbar={
        <div className="qf-m-topbar">
          <div/>
          <div className="qf-m-topbar__titleBlock" style={{textAlign:'center'}}>
            <div className="qf-m-topbar__title" style={{justifyContent:'center'}}>Activity</div>
          </div>
          <button className="qf-m-topbar__action">⚙</button>
        </div>
      }
      tabbar={<TabBar active="notifs"/>}
    >
      <div className="qf-m-segment">
        <button className="qf-m-segment__btn" aria-selected="true">All</button>
        <button className="qf-m-segment__btn">Mentions</button>
        <button className="qf-m-segment__btn">Threads</button>
      </div>

      <div className="qf-m-section">Today</div>

      <div className="qf-m-notif qf-m-notif--unread">
        <div className="qf-m-notif__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-500)'}}/></div>
        <div>
          <div className="qf-m-notif__head">
            <span className="qf-m-notif__actor">dev_lee</span>
            <span className="qf-m-notif__verb">mentioned you in <strong style={{color:'var(--text)'}}>#general</strong></span>
            <span className="qf-m-notif__time">5m</span>
          </div>
          <div className="qf-m-notif__preview">"…<span className="qf-mention">@designer_kim</span> 확인 부탁드려요!"</div>
        </div>
      </div>

      <div className="qf-m-notif qf-m-notif--unread">
        <div className="qf-m-notif__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-600)'}}/></div>
        <div>
          <div className="qf-m-notif__head">
            <span className="qf-m-notif__actor">designer_kim</span>
            <span className="qf-m-notif__verb">reacted 🦊 to your message</span>
            <span className="qf-m-notif__time">12m</span>
          </div>
          <div className="qf-m-notif__preview">"브랜드 에셋 전부 머지했습니다…"</div>
        </div>
      </div>

      <div className="qf-m-notif">
        <div className="qf-m-notif__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--warn-400)'}}/></div>
        <div>
          <div className="qf-m-notif__head">
            <span className="qf-m-notif__actor">founder_park</span>
            <span className="qf-m-notif__verb">invited you to <strong style={{color:'var(--text)'}}>#sprint-review</strong></span>
            <span className="qf-m-notif__time">1h</span>
          </div>
        </div>
      </div>

      <div className="qf-m-section">Earlier</div>

      <div className="qf-m-notif">
        <div className="qf-m-notif__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-300)'}}/></div>
        <div>
          <div className="qf-m-notif__head">
            <span className="qf-m-notif__actor">pm_choi</span>
            <span className="qf-m-notif__verb">replied in <strong style={{color:'var(--text)'}}>thread</strong></span>
            <span className="qf-m-notif__time">어제</span>
          </div>
          <div className="qf-m-notif__preview">"내일 오전 10시 괜찮으세요?"</div>
        </div>
      </div>

      <div className="qf-m-notif">
        <div className="qf-m-notif__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-700)'}}/></div>
        <div>
          <div className="qf-m-notif__head">
            <span className="qf-m-notif__actor">ops_han</span>
            <span className="qf-m-notif__verb">started a voice call in <strong style={{color:'var(--text)'}}>🔊 voice-lounge</strong></span>
            <span className="qf-m-notif__time">월</span>
          </div>
        </div>
      </div>
    </MobileScreen>
  );
}

// ───── Screen 4: Voice + bottom sheet ─────
function ScreenVoice() {
  const tiles = [
    {n:'dev_lee', c:'var(--a-500)', speaking:true},
    {n:'designer_kim', c:'var(--a-700)', muted:true},
    {n:'pm_choi', c:'var(--a-300)'},
    {n:'founder_park', c:'var(--warn-400)'},
    {n:'eng_jung', c:'var(--a-400)', muted:true},
    {n:'You', c:'var(--a-600)'},
  ];
  return (
    <div className="qf-m-screen" style={{position:'relative'}}>
      <div className="qf-m-topbar">
        <button className="qf-m-topbar__back">⌄</button>
        <div className="qf-m-topbar__titleBlock" style={{textAlign:'center'}}>
          <div className="qf-m-topbar__title" style={{justifyContent:'center'}}>🔊 voice-lounge</div>
          <div className="qf-m-topbar__subtitle">qufox team</div>
        </div>
        <button className="qf-m-topbar__action">👥</button>
      </div>

      <div className="qf-m-body">
        <div className="qf-m-voice">
          <div className="qf-m-voice__head">
            <span className="qf-m-voice__live">LIVE</span>
            <span style={{color:'var(--text-muted)',fontSize:'var(--fs-13)'}}>6 connected · 12:34</span>
          </div>
          <div className="qf-m-voice__grid">
            {tiles.map((t,i)=>(
              <div key={i} className={'qf-m-voice__tile'+(t.speaking?' qf-m-voice__tile--speaking':'')}>
                <div className="qf-avatar qf-avatar--md" style={{background:t.c}}/>
                <div className="qf-m-voice__tile-name">{t.n}</div>
                {t.muted && <div className="qf-m-voice__tile-muted">🔇</div>}
              </div>
            ))}
          </div>
          <div className="qf-m-voice__controls">
            <button className="qf-m-voice__ctrl">🎤</button>
            <button className="qf-m-voice__ctrl">📹</button>
            <button className="qf-m-voice__ctrl">🖥</button>
            <button className="qf-m-voice__ctrl qf-m-voice__ctrl--leave">↗</button>
          </div>
        </div>

        <div className="qf-m-section">Chat in call</div>
        <div className="qf-m-msg qf-m-msg--head">
          <div className="qf-m-msg__avatar"><div className="qf-avatar qf-avatar--md" style={{background:'var(--a-500)'}}/></div>
          <div>
            <div className="qf-m-msg__meta"><span className="qf-m-msg__author">dev_lee</span><span className="qf-m-msg__time">방금</span></div>
            <div className="qf-m-msg__body">화면 공유할게요 🖥</div>
          </div>
        </div>
      </div>

      {/* bottom sheet overlay */}
      <div className="qf-m-sheet-backdrop" style={{position:'absolute'}}>
        <div className="qf-m-sheet">
          <div className="qf-m-sheet__grab"/>
          <div className="qf-m-sheet__title">Message options</div>
          <div className="qf-m-sheet__item"><span className="qf-m-sheet__icon">😀</span>Add reaction</div>
          <div className="qf-m-sheet__item"><span className="qf-m-sheet__icon">💬</span>Reply in thread</div>
          <div className="qf-m-sheet__item"><span className="qf-m-sheet__icon">📌</span>Pin message</div>
          <div className="qf-m-sheet__item"><span className="qf-m-sheet__icon">🔗</span>Copy link</div>
          <div className="qf-m-sheet__divider"/>
          <div className="qf-m-sheet__item qf-m-sheet__item--danger"><span className="qf-m-sheet__icon">🗑</span>Delete message</div>
        </div>
      </div>
    </div>
  );
}

// ───── Mount all 4 screens side-by-side ─────
function MobileMockups() {
  const screens = [
    {t:'DMs · Inbox', s:<ScreenDMs/>, note:'Home · 대화 목록 + 검색 + FAB (Slack 패턴)'},
    {t:'Channel',    s:<ScreenChannel/>, note:'채팅 화면 · Composer 고정 · Swipe to reply'},
    {t:'Activity',   s:<ScreenActivity/>, note:'Mentions · Reactions · 스레드 알림'},
    {t:'Voice + Sheet', s:<ScreenVoice/>, note:'Voice 그리드 + Bottom sheet 액션'},
  ];
  return (
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(320px,1fr))',gap:'var(--s-7)'}}>
      {screens.map((sc,i)=>(
        <div key={i} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:'var(--s-4)'}}>
          <div style={{transform:'scale(0.78)',transformOrigin:'top center',marginBottom:'-18%'}}>
            <IOSDevice width={390} height={780} dark={true}>
              {sc.s}
            </IOSDevice>
          </div>
          <div style={{textAlign:'center'}}>
            <div className="qf-eyebrow">{String(i+1).padStart(2,'0')}</div>
            <div style={{font:'600 var(--fs-15) var(--font-sans)',color:'var(--text-strong)',marginTop:2}}>{sc.t}</div>
            <div style={{fontSize:'var(--fs-13)',color:'var(--text-muted)',maxWidth:280,margin:'4px auto 0'}}>{sc.note}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('mobile-mount')).render(<MobileMockups/>);
