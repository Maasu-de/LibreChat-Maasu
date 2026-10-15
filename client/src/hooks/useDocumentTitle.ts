// useDocumentTitle.js
import { useEffect } from 'react';
import { formatChatTitle } from '~/utils/chatTitle';

// function useDocumentTitle(title, prevailOnUnmount = false) {
// const defaultTitle = useRef(document.title);
function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = formatChatTitle(title);
  }, [title]);

  // useEffect(
  //   () => () => {
  //     if (!prevailOnUnmount) {
  //       document.title = defaultTitle.current;
  //     }
  //   }, []
  // );
}

export default useDocumentTitle;
